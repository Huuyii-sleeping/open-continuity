import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { MemoryService } from "../src/core/memory-service.js";
import { JsonFileStore } from "../src/core/memory-store.js";
import { SqliteMemoryStore } from "../src/sqlite/sqlite-memory-store.js";
import { exportSqliteToJson, importJsonToSqlite } from "../src/sqlite/transfer.js";

describe("SQLite JSON transfer", () => {
  const temporaryDirectories: string[] = [];
  afterEach(() => { for (const directory of temporaryDirectories.splice(0)) rmSync(directory, { recursive: true, force: true }); });

  it("imports an existing JSON ledger and exports an equivalent event stream", async () => {
    const directory = mkdtempSync(join(homedir(), ".open-continuity-transfer-test-"));
    temporaryDirectories.push(directory);
    const input = join(directory, "input.json");
    const database = join(directory, "memories.db");
    const output = join(directory, "output.json");
    const json = new MemoryService(new JsonFileStore(input));
    const first = await json.remember({ userId: "u1", agentId: "codex", key: "language", value: "TypeScript", kind: "user_preference", idempotencyKey: "transfer-1" });
    await json.remember({ userId: "u1", agentId: "claude", key: "language", value: "Rust", kind: "user_preference", idempotencyKey: "transfer-2" });
    await json.remember({ userId: "u1", agentId: "codex", key: "temporary", value: true, kind: "task_state", idempotencyKey: "transfer-3" });
    const temporary = (await json.recall({ userId: "u1", agentId: "codex", key: "temporary" })).memories[0];
    await json.forget({ userId: "u1", agentId: "codex", memoryId: temporary.id });

    expect(importJsonToSqlite(input, database)).toBe(4);
    const sqlite = new MemoryService(new SqliteMemoryStore(database));
    expect((await sqlite.recall({ userId: "u1", agentId: "reader" })).memories).toMatchObject([{ id: first.current.id, value: "Rust", version: 2 }]);
    await sqlite.close();

    expect(exportSqliteToJson(database, output)).toBe(4);
    expect(existsSync(output)).toBe(true);
    expect(JSON.parse(readFileSync(output, "utf8"))).toEqual(JSON.parse(readFileSync(input, "utf8")));
  });

  it("refuses to import into a non-empty SQLite database", async () => {
    const directory = mkdtempSync(join(homedir(), ".open-continuity-transfer-test-"));
    temporaryDirectories.push(directory);
    const input = join(directory, "input.json");
    const database = join(directory, "memories.db");
    const json = new MemoryService(new JsonFileStore(input));
    await json.remember({ userId: "u1", agentId: "codex", key: "a", value: 1, kind: "user_fact", idempotencyKey: "source" });
    const sqlite = new MemoryService(new SqliteMemoryStore(database));
    await sqlite.remember({ userId: "u1", agentId: "codex", key: "b", value: 2, kind: "user_fact", idempotencyKey: "target" });
    await sqlite.close();
    expect(() => importJsonToSqlite(input, database)).toThrow("SQLite import target must be empty");
  });
});
