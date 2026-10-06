import { mkdtempSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { DataType, newDb } from "pg-mem";
import { afterEach, describe, expect, it } from "vitest";
import { MemoryService } from "../src/core/memory-service.js";
import { JsonFileStore, type MemoryStore } from "../src/core/memory-store.js";
import { PostgresMemoryStore, type DatabasePool } from "../src/postgres/postgres-memory-store.js";
import { SqliteMemoryStore } from "../src/sqlite/sqlite-memory-store.js";

interface TestRuntime { service: MemoryService; cleanup: () => Promise<void> }

describe("persistent MemoryStore contract", () => {
  const temporaryDirectories: string[] = [];
  const cleanups: Array<() => Promise<void>> = [];
  afterEach(async () => {
    await Promise.all(cleanups.splice(0).map((cleanup) => cleanup()));
    for (const directory of temporaryDirectories.splice(0)) rmSync(directory, { recursive: true, force: true });
  });

  function directory(): string {
    const value = mkdtempSync(join(homedir(), ".open-continuity-contract-test-"));
    temporaryDirectories.push(value);
    return value;
  }

  async function runtime(kind: "json" | "sqlite" | "postgres"): Promise<TestRuntime> {
    let store: MemoryStore;
    let pool: DatabasePool | undefined;
    if (kind === "json") store = new JsonFileStore(join(directory(), "memories.json"));
    else if (kind === "sqlite") store = new SqliteMemoryStore(join(directory(), "memories.db"));
    else {
      const database = newDb({ autoCreateForeignKeyIndices: true });
      database.public.registerFunction({ name: "pg_advisory_xact_lock", args: [DataType.integer], returns: DataType.integer, implementation: () => 1 });
      const adapter = database.adapters.createPg();
      const postgresPool: DatabasePool = new adapter.Pool();
      pool = postgresPool;
      store = new PostgresMemoryStore(postgresPool);
    }
    const service = new MemoryService(store);
    const cleanup = async () => { await service.close(); await pool?.end?.(); };
    cleanups.push(cleanup);
    return { service, cleanup };
  }

  for (const kind of ["json", "sqlite", "postgres"] as const) {
    it(`${kind} satisfies shared version, visibility, history, idempotency, and forget semantics`, async () => {
      const { service } = await runtime(kind);
      const firstInput = { userId: "contract-user", agentId: "codex", key: "style", value: "concise", kind: "user_preference" as const, idempotencyKey: `${kind}-1` };
      const first = await service.remember(firstInput);
      expect((await service.remember(firstInput)).duplicate).toBe(true);
      const second = await service.remember({ ...firstInput, agentId: "claude", value: "detailed", idempotencyKey: `${kind}-2` });
      expect(second.current).toMatchObject({ id: first.current.id, value: "detailed", version: 2, supersedes: { eventId: first.event.id, version: 1 } });
      expect(second.evolution).toMatchObject({ action: "replaced", version: 2, writeMode: "replace", concurrency: "last_write_wins", supersedes: { eventId: first.event.id, version: 1 } });

      const merged = await service.remember({
        userId: "contract-user", agentId: "codex", key: "settings", value: { editor: { fontSize: 14, theme: "light" } },
        kind: "user_preference", expectedVersion: 0, idempotencyKey: `${kind}-merge-1`,
      });
      const patch = await service.remember({
        userId: "contract-user", agentId: "claude", key: "settings", value: { editor: { theme: "dark" }, autosave: true },
        kind: "user_preference", writeMode: "merge", expectedVersion: 1, idempotencyKey: `${kind}-merge-2`,
      });
      expect(patch.current).toMatchObject({ value: { editor: { fontSize: 14, theme: "dark" }, autosave: true }, version: 2, supersedes: { eventId: merged.event.id, version: 1 } });
      expect((await service.remember({
        userId: "contract-user", agentId: "claude", key: "settings", value: { editor: { theme: "dark" }, autosave: true },
        kind: "user_preference", writeMode: "merge", expectedVersion: 1, idempotencyKey: `${kind}-merge-2`,
      })).duplicate).toBe(true);
      await expect(service.remember({
        userId: "contract-user", agentId: "glm", key: "settings", value: { stale: true }, kind: "user_preference", expectedVersion: 1, idempotencyKey: `${kind}-stale`,
      })).rejects.toMatchObject({ code: "VERSION_CONFLICT" });

      await service.remember({ userId: "contract-user", agentId: "codex", key: "private", value: true, kind: "user_fact", sensitivity: "private", idempotencyKey: `${kind}-3` });
      await service.remember({ userId: "contract-user", agentId: "codex", key: "agent", value: true, kind: "user_fact", scope: "agent", idempotencyKey: `${kind}-4` });
      expect((await service.recall({ userId: "contract-user", agentId: "reader" })).memories.map((memory) => memory.key).sort()).toEqual(["settings", "style"]);
      expect((await service.history({ userId: "contract-user", agentId: "reader", memoryId: first.current.id })).events).toHaveLength(2);

      await service.forget({ userId: "contract-user", agentId: "reader", memoryId: first.current.id });
      expect((await service.recall({ userId: "contract-user", agentId: "reader", key: "style" })).memories).toHaveLength(0);
      expect((await service.history({ userId: "contract-user", agentId: "reader", memoryId: first.current.id })).events).toHaveLength(3);
    });
  }
});
