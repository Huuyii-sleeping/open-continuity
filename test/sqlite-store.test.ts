import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { MemoryService } from "../src/core/memory-service.js";
import { SqliteMemoryStore } from "../src/sqlite/sqlite-memory-store.js";

describe("SqliteMemoryStore", () => {
  const temporaryDirectories: string[] = [];
  const services: MemoryService[] = [];

  afterEach(async () => {
    await Promise.all(services.splice(0).map((service) => service.close()));
    for (const directory of temporaryDirectories.splice(0)) rmSync(directory, { recursive: true, force: true });
  });

  function databasePath(): string {
    const directory = mkdtempSync(join(homedir(), ".open-continuity-sqlite-test-"));
    temporaryDirectories.push(directory);
    return join(directory, "memories.db");
  }

  it("persists across instances and uses FTS5 for English and Chinese queries", async () => {
    const path = databasePath();
    const writer = new MemoryService(new SqliteMemoryStore(path));
    services.push(writer);
    const first = await writer.remember({
      userId: "u1", agentId: "codex", key: "answer_style", value: "用户喜欢简洁回答",
      kind: "user_preference", idempotencyKey: "sqlite-1",
    });
    await writer.close();
    services.splice(services.indexOf(writer), 1);

    const reader = new MemoryService(new SqliteMemoryStore(path));
    services.push(reader);
    expect((await reader.recall({ userId: "u1", agentId: "claude", query: "answer_style" })).memories[0]?.id).toBe(first.current.id);
    expect((await reader.recall({ userId: "u1", agentId: "claude", query: "简洁回答" })).memories[0]?.value).toBe("用户喜欢简洁回答");
    expect((await reader.recall({ userId: "u1", agentId: "claude", query: "简洁" })).memories[0]?.value).toBe("用户喜欢简洁回答");
  });

  it("migrates an existing V0.8 database without losing memory", async () => {
    const path = databasePath();
    const database = new DatabaseSync(path);
    database.exec(`
      CREATE TABLE open_continuity_schema_migrations (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL);
      CREATE TABLE memories_current (
        id TEXT PRIMARY KEY, user_id TEXT NOT NULL, memory_key TEXT NOT NULL, value TEXT NOT NULL, kind TEXT NOT NULL, scope TEXT NOT NULL, task_id TEXT,
        owner_agent_id TEXT, sensitivity TEXT NOT NULL, user_confirmed INTEGER NOT NULL, source_event_id TEXT NOT NULL, source_agent_id TEXT NOT NULL,
        updated_at TEXT NOT NULL, version INTEGER NOT NULL, scope_identity TEXT NOT NULL, UNIQUE (user_id, scope, scope_identity, memory_key)
      );
      CREATE TABLE memory_events (
        id TEXT PRIMARY KEY, user_id TEXT NOT NULL, agent_id TEXT NOT NULL, event_type TEXT NOT NULL, memory_id TEXT NOT NULL, memory_key TEXT NOT NULL,
        value TEXT, kind TEXT NOT NULL, scope TEXT NOT NULL, task_id TEXT, sensitivity TEXT NOT NULL, user_confirmed INTEGER NOT NULL, idempotency_key TEXT NOT NULL,
        created_at TEXT NOT NULL, metadata TEXT NOT NULL DEFAULT '{}', memory_version INTEGER NOT NULL, UNIQUE (user_id, idempotency_key)
      );
      CREATE INDEX memories_current_recall_idx ON memories_current (user_id, updated_at DESC, id DESC);
      CREATE INDEX memories_current_task_idx ON memories_current (user_id, task_id, updated_at DESC);
      CREATE INDEX memories_current_agent_idx ON memories_current (user_id, owner_agent_id, updated_at DESC);
      CREATE INDEX memory_events_history_idx ON memory_events (user_id, created_at DESC, id DESC);
      CREATE INDEX memory_events_memory_idx ON memory_events (user_id, memory_id, created_at DESC, id DESC);
      CREATE VIRTUAL TABLE memories_fts USING fts5(memory_id UNINDEXED, memory_key, value_text, tokenize='trigram');
      CREATE TRIGGER memories_current_fts_insert AFTER INSERT ON memories_current BEGIN INSERT INTO memories_fts (memory_id, memory_key, value_text) VALUES (new.id, new.memory_key, new.value); END;
      CREATE TRIGGER memories_current_fts_update AFTER UPDATE OF id, memory_key, value ON memories_current BEGIN DELETE FROM memories_fts WHERE memory_id = old.id; INSERT INTO memories_fts (memory_id, memory_key, value_text) VALUES (new.id, new.memory_key, new.value); END;
      CREATE TRIGGER memories_current_fts_delete AFTER DELETE ON memories_current BEGIN DELETE FROM memories_fts WHERE memory_id = old.id; END;
    `);
    const timestamp = new Date().toISOString();
    database.prepare("INSERT INTO open_continuity_schema_migrations (version, applied_at) VALUES (1, ?), (2, ?)").run(timestamp, timestamp);
    database.prepare("INSERT INTO memories_current VALUES (?, ?, ?, ?, ?, ?, NULL, NULL, ?, ?, ?, ?, ?, ?, ?)").run("memory-1", "u1", "language", '"TypeScript"', "user_fact", "user", "public", 1, "event-1", "codex", timestamp, 1, "-");
    database.prepare("INSERT INTO memory_events VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?, ?, ?, ?, ?)").run("event-1", "u1", "codex", "memory_remembered", "memory-1", "language", '"TypeScript"', "user_fact", "user", "public", 1, "v08-event", timestamp, "{}", 1);
    database.prepare("INSERT INTO memories_fts VALUES (?, ?, ?)").run("memory-1", "language", '"TypeScript"');
    database.close();

    const service = new MemoryService(new SqliteMemoryStore(path));
    services.push(service);
    expect((await service.recall({ userId: "u1", agentId: "claude" })).memories[0]).toMatchObject({ value: "TypeScript", version: 1 });
    const updated = await service.remember({ userId: "u1", agentId: "claude", key: "language", value: "Rust", kind: "user_fact", expectedVersion: 1, idempotencyKey: "v09-update" });
    expect(updated.current).toMatchObject({ value: "Rust", version: 2, supersedes: { eventId: "event-1", version: 1 } });
  });

  it("enforces idempotency, scope, private filtering, pagination, and forget", async () => {
    const service = new MemoryService(new SqliteMemoryStore(databasePath()));
    services.push(service);
    const sharedInput = { userId: "u1", agentId: "codex", key: "shared", value: "visible", kind: "user_fact" as const, idempotencyKey: "sqlite-idempotent" };
    const shared = await service.remember(sharedInput);
    expect((await service.remember(sharedInput)).duplicate).toBe(true);
    await expect(service.remember({ ...sharedInput, value: "different" })).rejects.toMatchObject({ code: "IDEMPOTENCY_CONFLICT" });

    await service.remember({ userId: "u1", agentId: "codex", key: "task", value: "task-only", kind: "task_state", scope: "task", taskId: "t1", idempotencyKey: "sqlite-task" });
    await service.remember({ userId: "u1", agentId: "codex", key: "agent", value: "codex-only", kind: "user_fact", scope: "agent", idempotencyKey: "sqlite-agent" });
    await service.remember({ userId: "u1", agentId: "codex", key: "secret", value: "hidden", kind: "user_fact", sensitivity: "private", idempotencyKey: "sqlite-private" });

    expect((await service.recall({ userId: "u1", agentId: "claude", limit: 10 })).memories.map((memory) => memory.value)).toEqual(["visible"]);
    expect((await service.recall({ userId: "u1", agentId: "claude", taskId: "t1", limit: 10 })).memories.map((memory) => memory.value).sort()).toEqual(["task-only", "visible"]);
    const firstPage = await service.recall({ userId: "u1", agentId: "codex", taskId: "t1", includePrivate: true, limit: 2 });
    const secondPage = await service.recall({ userId: "u1", agentId: "codex", taskId: "t1", includePrivate: true, limit: 2, cursor: firstPage.nextCursor! });
    expect(firstPage.nextCursor).not.toBeNull();
    expect(new Set([...firstPage.memories, ...secondPage.memories].map((memory) => memory.id)).size).toBe(4);

    await service.forget({ userId: "u1", agentId: "claude", memoryId: shared.current.id });
    expect((await service.recall({ userId: "u1", agentId: "claude" })).memories).toHaveLength(0);
    expect((await service.history({ userId: "u1", agentId: "claude", memoryId: shared.current.id })).events).toHaveLength(2);
  });

  it("preserves concurrent writes from separate processes", async () => {
    const path = databasePath();
    const workerPath = join(process.cwd(), "test/helpers/sqlite-store-worker.ts");
    const workers = Array.from({ length: 8 }, (_, index) => new Promise<void>((resolve, reject) => {
      const child = spawn(process.execPath, ["--import", "tsx/esm", workerPath], {
        cwd: process.cwd(), env: { ...process.env, OPEN_CONTINUITY_TEST_SQLITE: path, OPEN_CONTINUITY_TEST_INDEX: String(index) },
        stdio: ["ignore", "pipe", "pipe"],
      });
      let stderr = "";
      child.stderr.on("data", (chunk) => { stderr += String(chunk); });
      child.once("error", reject);
      child.once("exit", (code) => code === 0 ? resolve() : reject(new Error(`Worker exited with ${code}: ${stderr}`)));
    }));
    await Promise.all(workers);

    const service = new MemoryService(new SqliteMemoryStore(path));
    services.push(service);
    const memories = (await service.recall({ userId: "concurrent-user", agentId: "reader", limit: 100 })).memories;
    expect(memories).toHaveLength(1);
    expect(memories[0]).toMatchObject({ key: "shared-status", version: 8 });
    expect((await service.history({ userId: "concurrent-user", agentId: "reader", limit: 100 })).events).toHaveLength(8);
  }, 15000);

  it("allows only one cross-process compare-and-set update for the same version", async () => {
    const path = databasePath();
    const seed = new MemoryService(new SqliteMemoryStore(path));
    services.push(seed);
    await seed.remember({ userId: "cas-user", agentId: "seed", key: "shared-status", value: "initial", kind: "task_state", expectedVersion: 0, idempotencyKey: "sqlite-cas-seed" });
    await seed.close();
    services.splice(services.indexOf(seed), 1);

    const workerPath = join(process.cwd(), "test/helpers/sqlite-cas-worker.ts");
    const results = await Promise.all([0, 1].map((index) => new Promise<{ ok: boolean; code?: string; version?: number }>((resolve, reject) => {
      const child = spawn(process.execPath, ["--import", "tsx/esm", workerPath], {
        cwd: process.cwd(), env: { ...process.env, OPEN_CONTINUITY_TEST_SQLITE: path, OPEN_CONTINUITY_TEST_INDEX: String(index) },
        stdio: ["ignore", "pipe", "pipe"],
      });
      let stdout = ""; let stderr = "";
      child.stdout.on("data", (chunk) => { stdout += String(chunk); });
      child.stderr.on("data", (chunk) => { stderr += String(chunk); });
      child.once("error", reject);
      child.once("exit", (code) => code === 0 ? resolve(JSON.parse(stdout)) : reject(new Error(`Worker exited with ${code}: ${stderr}`)));
    })));

    expect(results.filter((result) => result.ok)).toEqual([{ ok: true, version: 2 }]);
    expect(results.filter((result) => !result.ok)).toEqual([{ ok: false, code: "VERSION_CONFLICT" }]);
    const reader = new MemoryService(new SqliteMemoryStore(path));
    services.push(reader);
    expect((await reader.history({ userId: "cas-user", agentId: "reader" })).events).toHaveLength(2);
  }, 15000);
});
