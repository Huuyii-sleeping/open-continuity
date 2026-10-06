import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { MemoryService } from "../src/core/memory-service.js";
import { backupSqliteDatabase, inspectSqliteDatabase, restoreSqliteDatabase } from "../src/sqlite/maintenance.js";
import { SqliteMemoryStore } from "../src/sqlite/sqlite-memory-store.js";

describe("SQLite maintenance", () => {
  const directories: string[] = [];
  afterEach(() => { for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true }); });

  function workspace(): string {
    const directory = mkdtempSync(join(homedir(), ".open-continuity-maintenance-test-"));
    directories.push(directory);
    return directory;
  }

  it("creates a consistent backup while WAL is active and restores it over a changed database", async () => {
    const directory = workspace();
    const source = join(directory, "memories.db");
    const backup = join(directory, "backups", "memories.db");
    const service = new MemoryService(new SqliteMemoryStore(source));
    await service.remember({ userId: "fictional-user", agentId: "agent-a", key: "language", value: "TypeScript", kind: "user_preference", idempotencyKey: "maintenance-1" });

    const result = backupSqliteDatabase(source, backup);
    expect(result).toMatchObject({ output: backup, status: { ok: true, recognized: true, supportedSchema: true, memories: 1, events: 1 } });
    expect(existsSync(backup)).toBe(true);

    await service.remember({ userId: "fictional-user", agentId: "agent-a", key: "temporary", value: true, kind: "task_state", idempotencyKey: "maintenance-2" });
    await service.close();
    expect(inspectSqliteDatabase(source).memories).toBe(2);

    const restoredPath = join(directory, "restored.db");
    const restored = restoreSqliteDatabase(backup, restoredPath);
    expect(restored.status).toMatchObject({ ok: true, memories: 1, events: 1 });
    expect(inspectSqliteDatabase(source)).toMatchObject({ memories: 2, events: 2 });

    const reader = new MemoryService(new SqliteMemoryStore(restoredPath));
    expect((await reader.recall({ userId: "fictional-user", agentId: "agent-b", limit: 10 })).memories).toMatchObject([{ key: "language", value: "TypeScript" }]);
    await reader.close();
  });

  it("rejects corrupt and unrelated backup files without replacing the target", async () => {
    const directory = workspace();
    const target = join(directory, "target.db");
    const targetService = new MemoryService(new SqliteMemoryStore(target));
    await targetService.remember({ userId: "fictional-user", agentId: "agent-a", key: "safe", value: true, kind: "user_fact", idempotencyKey: "target-1" });
    await targetService.close();

    const corrupt = join(directory, "corrupt.db");
    writeFileSync(corrupt, "this is not sqlite", "utf8");
    const output = join(directory, "restored.db");
    expect(() => restoreSqliteDatabase(corrupt, output)).toThrow();
    expect(inspectSqliteDatabase(target)).toMatchObject({ ok: true, memories: 1, events: 1 });

    const unrelated = join(directory, "unrelated.db");
    const database = new DatabaseSync(unrelated);
    database.exec("CREATE TABLE notes (value TEXT)");
    database.close();
    expect(() => restoreSqliteDatabase(unrelated, output)).toThrow("not an OpenContinuity database");
    expect(readFileSync(target).byteLength).toBeGreaterThan(0);
  });

  it("refuses to overwrite an existing restore output", async () => {
    const directory = workspace();
    const target = join(directory, "target.db");
    const backup = join(directory, "backup.db");
    const service = new MemoryService(new SqliteMemoryStore(target));
    await service.remember({ userId: "fictional-user", agentId: "agent-a", key: "active", value: true, kind: "user_fact", idempotencyKey: "active-1" });
    backupSqliteDatabase(target, backup);
    await service.close();
    expect(() => restoreSqliteDatabase(backup, target)).toThrow("Restore output already exists");
  });
});
