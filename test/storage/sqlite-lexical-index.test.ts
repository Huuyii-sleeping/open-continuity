import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MemoryService } from "../../src/core/application/memory-service.js";
import { SqliteMemoryStore } from "../../src/storage/sqlite/sqlite-memory-store.js";
import { sqliteLexicalText } from "../../src/storage/sqlite/lexical-index.js";
import { migrateSqlite } from "../../src/storage/sqlite/schema.js";
import { backupSqliteDatabase, restoreSqliteDatabase } from "../../src/storage/sqlite/maintenance.js";

const actor = { userId: "fictional-index-user", agentId: "fictional-index-agent" };
const roots: string[] = [], cleanup: Array<() => void | Promise<void>> = [];
afterEach(async () => { vi.restoreAllMocks(); for (const close of cleanup.splice(0)) await close(); for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function path() { const root = mkdtempSync(join(tmpdir(), "oc-fictional-lexical-index-")); roots.push(root); return join(root, "test.db"); }
function runtime(file = path()) { const store = new SqliteMemoryStore(file), service = new MemoryService(store); cleanup.push(() => service.close()); return { file, store, service }; }
function rows(file: string) { const db = new DatabaseSync(file, { readOnly: true }); try { return db.prepare("SELECT rowid, memory_id, memory_key, value_text FROM memories_fts ORDER BY rowid").all(); } finally { db.close(); } }
async function oldFixture() {
  const f = runtime();
  await f.service.remember({ ...actor, key: "fictional-path", value: "C:\\fictional\\orbit", kind: "user_fact", userConfirmed: true, idempotencyKey: "fictional-initial" });
  const events = f.store.exportEvents(); await f.service.close();
  const db = new DatabaseSync(f.file);
  db.exec(`DROP TRIGGER memories_current_fts_insert; DROP TRIGGER memories_current_fts_update; DROP TRIGGER memories_current_fts_delete;
    DROP TABLE memory_fts_keys; DELETE FROM memories_fts;
    INSERT INTO memories_fts (memory_id, memory_key, value_text) SELECT id, memory_key, value FROM memories_current;
    CREATE TRIGGER memories_current_fts_insert AFTER INSERT ON memories_current BEGIN INSERT INTO memories_fts (memory_id,memory_key,value_text) VALUES(new.id,new.memory_key,new.value); END;
    CREATE TRIGGER memories_current_fts_update AFTER UPDATE OF id,memory_key,value ON memories_current BEGIN DELETE FROM memories_fts WHERE memory_id=old.id; INSERT INTO memories_fts (memory_id,memory_key,value_text) VALUES(new.id,new.memory_key,new.value); END;
    CREATE TRIGGER memories_current_fts_delete AFTER DELETE ON memories_current BEGIN DELETE FROM memories_fts WHERE memory_id=old.id; END;
    DELETE FROM open_continuity_schema_migrations WHERE version=5;`);
  db.close(); return { ...f, events };
}
describe("SQLite lexical index storage", () => {
  it("projects actual values/field names without serialization escapes or array-index tokens", () => {
    expect(sqliteLexicalText(JSON.stringify({ path: "C:\\fictional\\orbit", note: 'fictional "dock"', flags: [true, false, null, -12.5] })))
      .toBe('path\nC:\\fictional\\orbit\nnote\nfictional "dock"\nflags\ntrue\nfalse\nnull\n-12.5');
    expect(sqliteLexicalText(JSON.stringify("fictional\0satellite"))).toBe("fictional satellite");
    expect(sqliteLexicalText(JSON.stringify("fictional \\u0000marker"))).toBe("fictional \\u0000marker");
    expect(() => sqliteLexicalText("invalid fictional JSON")).toThrow();
  });
  it("migrates v4 search data atomically while keeping source events and raw values", async () => {
    const f = await oldFixture(), before = rows(f.file);
    expect(before[0]!.value_text).toBe(JSON.stringify("C:\\fictional\\orbit"));
    const upgraded = runtime(f.file);
    expect(upgraded.store.exportEvents()).toEqual(f.events);
    expect(rows(f.file)[0]!.value_text).toBe("C:\\fictional\\orbit");
    expect((await upgraded.service.recall({ ...actor, query: "C:\\fictional\\orbit" })).memories[0]!.value).toBe("C:\\fictional\\orbit");
    await upgraded.service.close(); const reopened = runtime(f.file);
    expect(reopened.store.exportEvents()).toEqual(f.events); expect(rows(f.file)).toHaveLength(1);
  });
  it("retains the legacy projection without claiming schema-5 capabilities when migration is disabled", async () => {
    const f = await oldFixture(), store = new SqliteMemoryStore(f.file, { autoMigrate: false }), service = new MemoryService(store);
    cleanup.push(() => service.close());
    expect(store.lexicalIndexVersion).toBeUndefined(); expect(service.retrievalCapabilityPolicy().lexicalIndexVersion).toBeNull();
    const candidates = await store.candidateReaders.full_text({ ...actor, query: "C:\\fictional\\orbit" });
    expect(candidates.lexicalIndexVersion).toBeUndefined(); expect(candidates.hits).toEqual([]);
    expect(store.exportEvents()).toEqual(f.events);
  });
  it("restores v4 triggers/index and version markers on failed v5 migration, then retries", async () => {
    const f = await oldFixture(), before = rows(f.file), db = new DatabaseSync(f.file); cleanup.push(() => db.close());
    const original = db.exec.bind(db);
    const spy = vi.spyOn(db, "exec").mockImplementation(sql => {
      if (sql.startsWith("CREATE TRIGGER memories_current_fts_insert")) throw new Error("fictional v5 migration fault");
      original(sql);
    });
    expect(() => migrateSqlite(db)).toThrow("fictional v5 migration fault"); spy.mockRestore();
    expect(rows(f.file)).toEqual(before);
    expect(db.prepare("SELECT max(version) AS version FROM open_continuity_schema_migrations").get()!.version).toBe(4);
    expect(db.prepare("SELECT name FROM sqlite_master WHERE name='memory_fts_keys'").get()).toBeUndefined();
    migrateSqlite(db);
    expect(db.prepare("SELECT max(version) AS version FROM open_continuity_schema_migrations").get()!.version).toBe(5);
    expect(rows(f.file)[0]!.value_text).toBe("C:\\fictional\\orbit");
  });
  it("rolls back pointer/FTS publication with a failed event and preserves indexed retry/idempotency", async () => {
    const f = runtime(); const input = { ...actor, key: "fictional-path", value: "fictional oldmarker", kind: "user_fact" as const, userConfirmed: true, idempotencyKey: "fictional-first" };
    const first = await f.service.remember(input), before = rows(f.file);
    const db = new DatabaseSync(f.file); cleanup.push(() => db.close());
    db.exec("CREATE TRIGGER fictional_reject BEFORE INSERT ON memory_events WHEN new.idempotency_key='fictional-retry' BEGIN SELECT RAISE(ABORT,'fictional event fault'); END");
    const update = { ...input, value: "fictional newmarker", expectedVersion: 1, idempotencyKey: "fictional-retry" };
    await expect(f.service.remember(update)).rejects.toMatchObject({ code: "STORAGE_ERROR" });
    expect(rows(f.file)).toEqual(before); expect(f.store.exportEvents()).toHaveLength(1);
    db.exec("DROP TRIGGER fictional_reject"); const updated = await f.service.remember(update);
    expect(rows(f.file)[0]!.rowid).toBe(before[0]!.rowid); expect((await f.service.remember(update)).duplicate).toBe(true);
    expect(rows(f.file)).toHaveLength(1); expect(updated.current.version).toBe(2);
    await f.service.forget({ ...actor, memoryId: first.current.id });
    expect(rows(f.file)).toEqual([]); expect(db.prepare("SELECT count(*) AS n FROM memory_fts_keys").get()!.n).toBe(0);
  });
  it("keeps stable pointers across VACUUM backup/restore and later update/forget", async () => {
    const f = runtime(); const receipts = [];
    for (const key of ["fictional-a", "fictional-hole", "fictional-b"]) receipts.push(await f.service.remember({ ...actor, key, value: "fictional needle", kind: "user_fact", userConfirmed: true, idempotencyKey: key }));
    await f.service.forget({ ...actor, memoryId: receipts[1]!.current.id });
    const before = rows(f.file), backup = f.file + ".backup", restored = f.file + ".restored";
    backupSqliteDatabase(f.file, backup); await f.service.close(); restoreSqliteDatabase(backup, restored);
    const copy = runtime(restored); expect(rows(restored)).toEqual(before);
    await copy.service.remember({ ...actor, key: "fictional-b", value: "fictional changedmarker", kind: "user_fact", userConfirmed: true, expectedVersion: 1, idempotencyKey: "fictional-change" });
    expect(rows(restored)).toHaveLength(2); expect((await copy.service.recall({ ...actor, query: "changedmarker" })).memories[0]!.id).toBe(receipts[2]!.current.id);
    await copy.service.forget({ ...actor, memoryId: receipts[2]!.current.id });
    expect(rows(restored).map(row => row.memory_id)).toEqual([receipts[0]!.current.id]);
  });
  it("publishes unchanged-content metadata/version updates without rewriting FTS", async () => {
    const f = runtime(); const input = { ...actor, key: "fictional-stable", value: "fictional needle", kind: "user_fact" as const, userConfirmed: true, idempotencyKey: "fictional-first" };
    await f.service.remember(input); const before = rows(f.file);
    const db = new DatabaseSync(f.file); cleanup.push(() => db.close());
    db.exec("CREATE TRIGGER fictional_reject_reindex BEFORE UPDATE ON memory_fts_keys BEGIN SELECT RAISE(ABORT,'fictional FTS rewrite fault'); END");
    const receipt = await f.service.remember({ ...input, expectedVersion: 1, metadata: { fictional: "new provenance" }, idempotencyKey: "fictional-metadata" });
    expect(receipt.current.version).toBe(2); expect(rows(f.file)).toEqual(before);
    expect((await f.service.recall({ ...actor, query: "needle" })).memories[0]!.sourceEventId).toBe(receipt.event.id);
    const changed = { ...input, value: "fictional changedmarker", expectedVersion: 2, idempotencyKey: "fictional-changed" };
    await expect(f.service.remember(changed)).rejects.toMatchObject({ code: "STORAGE_ERROR" });
    expect(f.store.exportEvents()).toHaveLength(2); expect(rows(f.file)).toEqual(before);
    db.exec("DROP TRIGGER fictional_reject_reindex");
    expect((await f.service.remember(changed)).current.version).toBe(3);
  });
  it("deletes through an indexed stable pointer instead of scanning memory_id in FTS", () => {
    const f = runtime(), db = new DatabaseSync(f.file); cleanup.push(() => db.close());
    const plan = db.prepare("EXPLAIN QUERY PLAN DELETE FROM memories_fts WHERE rowid=(SELECT rowid FROM memory_fts_keys WHERE memory_id=?)").all("fictional-id").map(row => String(row.detail));
    expect(plan.some(detail => detail.includes("SEARCH memory_fts_keys"))).toBe(true);
    expect(plan.some(detail => detail.includes("VIRTUAL TABLE") && detail.includes("="))).toBe(true);
  });
  it("keeps one index pointer when importing a replacement with a different memory ID", async () => {
    const f = runtime(); const first = await f.service.remember({ ...actor, key: "fictional-import", value: "fictional oldmarker", kind: "user_fact", userConfirmed: true, idempotencyKey: "fictional-first" });
    const anchor = await f.service.remember({ ...actor, key: "fictional-anchor", value: "fictional anchor", kind: "user_fact", userConfirmed: true, idempotencyKey: "fictional-anchor" });
    const before = rows(f.file), memoryId = randomUUID(), imported = runtime();
    // The public importer accepts only an empty target; replay both initial events
    // and the replacement in one ledger transaction, with an anchor preserving row-ID gaps.
    imported.store.importEvents([first.event, anchor.event, { ...first.event, id: randomUUID(), memoryId, value: "fictional newmarker", inputValue: "fictional newmarker", memoryVersion: 2,
      evolutionAction: "replaced", expectedVersion: 1, supersedes: { eventId: first.event.id, version: 1 },
      createdAt: new Date(Date.parse(first.event.createdAt) + 1).toISOString(), idempotencyKey: "fictional-import-new" }]);
    expect(rows(imported.file)).toHaveLength(2); expect(rows(imported.file)[0]).toMatchObject({ rowid: before[0]!.rowid, memory_id: memoryId });
    expect((await imported.service.recall({ ...actor, query: "newmarker" })).memories[0]).toMatchObject({ id: memoryId, version: 2 });
    expect((await imported.service.recall({ ...actor, query: "oldmarker" })).memories).toHaveLength(0);
  });
});
