import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { DataType, newDb } from "pg-mem";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MemoryService } from "../src/core/memory-service.js";
import { InMemoryStore, JsonFileStore } from "../src/core/memory-store.js";
import { SqliteMemoryStore } from "../src/sqlite/sqlite-memory-store.js";
import { migrateSqlite } from "../src/sqlite/schema.js";
import { PostgresMemoryStore, type DatabasePool } from "../src/postgres/postgres-memory-store.js";

const faults = vi.hoisted(() => ({ rename: false }));
vi.mock("node:fs", async (original) => {
  const fs = await original<typeof import("node:fs")>();
  return { ...fs, renameSync: (...args: Parameters<typeof fs.renameSync>) => {
    if (faults.rename) { faults.rename = false; throw new Error("fictional rename failure"); }
    return fs.renameSync(...args);
  } };
});
const directories: string[] = [];
const close: Array<() => void | Promise<void>> = [];
afterEach(async () => {
  faults.rename = false; vi.restoreAllMocks();
  for (const action of close.splice(0)) await action();
  for (const root of directories.splice(0)) rmSync(root, { recursive: true, force: true });
});
function directory() { const root = mkdtempSync(join(tmpdir(), "open-continuity-storage-fault-")); directories.push(root); return root; }
const query = { userId: "fictional-fault-user", agentId: "fictional-reader" };
const input = { userId: query.userId, agentId: "fictional-writer", key: "fictional-state", value: "fictional old marker", kind: "user_fact" as const, idempotencyKey: "fictional-seed" };

describe("SQLite transaction and migration failure evidence", () => {
  it("rolls back current state, event and FTS when the event insert fails; retry remains valid", async () => {
    const path = join(directory(), "fictional.db");
    const store = new SqliteMemoryStore(path); close.push(() => store.close());
    const service = new MemoryService(store);
    await service.remember(input);
    const database = new DatabaseSync(path); close.push(() => database.close());
    database.exec("CREATE TRIGGER fictional_reject BEFORE INSERT ON memory_events WHEN new.idempotency_key = 'fictional-fail' BEGIN SELECT RAISE(ABORT, 'fictional fault'); END");
    const update = { ...input, value: "fictional new marker", expectedVersion: 1, idempotencyKey: "fictional-fail" };
    await expect(service.remember(update)).rejects.toMatchObject({ code: "STORAGE_ERROR" });
    expect((await service.recall(query)).memories[0]).toMatchObject({ value: input.value, version: 1 });
    expect((await service.history(query)).events).toHaveLength(1);
    expect((await service.recall({ ...query, query: input.value })).memories).toHaveLength(1);
    expect((await service.recall({ ...query, query: update.value })).memories).toHaveLength(0);
    database.exec("DROP TRIGGER fictional_reject");
    expect((await service.remember(update)).current.version).toBe(2);
    expect((await service.history(query)).events).toHaveLength(2);
  });

  it("rolls back the forget event when current-state deletion fails", async () => {
    const path = join(directory(), "fictional.db");
    const store = new SqliteMemoryStore(path); close.push(() => store.close());
    const service = new MemoryService(store);
    const receipt = await service.remember(input);
    const database = new DatabaseSync(path); close.push(() => database.close());
    database.exec("CREATE TRIGGER fictional_reject_delete BEFORE DELETE ON memories_current BEGIN SELECT RAISE(ABORT, 'fictional fault'); END");
    await expect(service.forget({ ...query, memoryId: receipt.current.id })).rejects.toMatchObject({ code: "STORAGE_ERROR" });
    expect((await service.recall(query)).memories).toHaveLength(1);
    expect((await service.history(query)).events).toHaveLength(1);
    database.exec("DROP TRIGGER fictional_reject_delete");
    await service.forget({ ...query, memoryId: receipt.current.id });
    expect((await service.history(query)).events).toHaveLength(2);
  });

  it("rolls back failed schema DDL/version markers and can retry migration", () => {
    const database = new DatabaseSync(":memory:"); close.push(() => database.close());
    const original = database.exec.bind(database);
    const spy = vi.spyOn(database, "exec").mockImplementation((sql) => {
      if (sql.startsWith("CREATE VIRTUAL TABLE")) throw new Error("fictional migration fault");
      original(sql);
    });
    expect(() => migrateSqlite(database)).toThrow("fictional migration fault");
    expect(database.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all()).toEqual([]);
    spy.mockRestore();
    migrateSqlite(database);
    expect(database.prepare("SELECT version FROM open_continuity_schema_migrations ORDER BY version").all().map((row) => row.version)).toEqual([1, 2, 3, 4]);
  });

  it("refuses a newer schema without changing stored data", async () => {
    const path = join(directory(), "fictional.db");
    const service = new MemoryService(new SqliteMemoryStore(path));
    await service.remember(input); await service.close();
    const database = new DatabaseSync(path); close.push(() => database.close());
    database.exec("INSERT INTO open_continuity_schema_migrations VALUES (999, '2030-01-01T00:00:00.000Z')");
    expect(() => new SqliteMemoryStore(path)).toThrow("schema version is not supported");
    expect(() => new SqliteMemoryStore(path, { autoMigrate: false })).toThrow("schema version is not supported");
    expect(database.prepare("SELECT COUNT(*) AS n FROM memories_current").get()!.n).toBe(1);
  });

  it("imports a ledger atomically: a duplicate event leaves no partial current/event/FTS state", async () => {
    const source = new InMemoryStore(); const service = new MemoryService(source); await service.remember(input);
    const target = new SqliteMemoryStore(join(directory(), "fictional.db")); close.push(() => target.close());
    const events = source.allEvents();
    expect(() => target.importEvents([...events, ...events])).toThrow();
    expect(target.exportEvents()).toEqual([]);
    expect((await new MemoryService(target).recall(query)).memories).toEqual([]);
    target.importEvents(events);
    expect((await new MemoryService(target).recall(query)).memories).toHaveLength(1);
  });
});

describe("JSON compatibility failure evidence", () => {
  it("keeps the previous ledger on failed publish and safely retries after reopening", async () => {
    const path = join(directory(), "fictional.json");
    const service = new MemoryService(new JsonFileStore(path));
    await service.remember(input);
    const before = readFileSync(path, "utf8");
    faults.rename = true;
    const update = { ...input, value: "fictional changed marker", expectedVersion: 1, idempotencyKey: "fictional-retry" };
    await expect(service.remember(update)).rejects.toMatchObject({ code: "STORAGE_ERROR" });
    expect(readFileSync(path, "utf8")).toBe(before);
    const reopened = new MemoryService(new JsonFileStore(path));
    expect((await reopened.history(query)).events).toHaveLength(1);
    expect((await reopened.remember(update)).current.version).toBe(2);
    expect((await service.remember(update)).duplicate).toBe(true);
  });

  it("fails closed on corrupt events instead of materializing unvalidated state", () => {
    const path = join(directory(), "fictional.json");
    writeFileSync(path, JSON.stringify({ events: [{ type: "memory_remembered", userId: query.userId }] }));
    expect(() => new JsonFileStore(path)).toThrow("valid memory ledger");
  });
});

describe("PostgreSQL driver protocol evidence (pg-mem does not verify rollback/locks)", () => {
  function pool(): DatabasePool {
    const database = newDb();
    database.public.registerFunction({ name: "pg_advisory_xact_lock", args: [DataType.integer], returns: DataType.integer, implementation: () => 1 });
    return new (database.adapters.createPg().Pool)();
  }

  it("recovers initialization after a transient connection failure", async () => {
    const actual = pool(); close.push(() => actual.end?.());
    let attempts = 0;
    const wrapper: DatabasePool = { connect: async () => { if (++attempts === 1) throw new Error("fictional connection fault"); return actual.connect(); } };
    const service = new MemoryService(new PostgresMemoryStore(wrapper));
    await expect(service.remember(input)).rejects.toMatchObject({ code: "STORAGE_ERROR" });
    expect((await service.remember(input)).current.version).toBe(1);
  });

  it("acquires ordered transaction locks before reading/writing and issues rollback on event failure", async () => {
    const actual = pool(); close.push(() => actual.end?.());
    const statements: Array<{ sql: string; values?: unknown[] }> = [];
    let fail = false; let releases = 0;
    const wrapper: DatabasePool = { connect: async () => {
      const client = await actual.connect();
      return { query: async (sql, values) => {
        statements.push({ sql, values });
        if (fail && sql.includes("INSERT INTO memory_events")) throw new Error("fictional event fault");
        return client.query(sql, values);
      }, release: () => { releases++; client.release(); } };
    } };
    const store = new PostgresMemoryStore(wrapper); await store.initialize();
    statements.length = 0; fail = true;
    await expect(new MemoryService(store).remember(input)).rejects.toMatchObject({ code: "STORAGE_ERROR", details: undefined });
    expect(statements[0]!.sql).toBe("BEGIN");
    expect(statements[1]!.sql).toContain("pg_advisory_xact_lock");
    expect(Number(statements[1]!.values![0])).toBeLessThan(0);
    expect(Number(statements[2]!.values![0])).toBeGreaterThanOrEqual(0);
    expect(statements.at(-1)!.sql).toBe("ROLLBACK");
    expect(statements.some((statement) => statement.sql === "COMMIT")).toBe(false);
    expect(releases).toBeGreaterThanOrEqual(2);
  });

  for (const operation of ["remember", "forget"] as const) {
    it(`sanitizes ${operation} rollback failure and discards the uncertain connection`, async () => {
      const actual = pool(); close.push(() => actual.end?.());
      const discarded: Array<boolean | Error | undefined> = [];
      let failing = false;
      const wrapper: DatabasePool = { connect: async () => {
        const client = await actual.connect();
        return { query: async (sql, values) => {
          if (failing && (sql === "ROLLBACK" || (operation === "remember" ? sql.includes("INSERT INTO memory_events") : sql.startsWith("DELETE FROM memories_current")))) {
            throw new Error("fictional-private-driver-details");
          }
          return client.query(sql, values);
        }, release: (destroy?: boolean | Error) => { discarded.push(destroy); client.release(); } };
      } };
      const service = new MemoryService(new PostgresMemoryStore(wrapper));
      const receipt = await service.remember(input);
      discarded.length = 0; failing = true;
      const pending = operation === "remember"
        ? service.remember({ ...input, value: "fictional update", idempotencyKey: "fictional-rollback-failure" })
        : service.forget({ ...query, memoryId: receipt.current.id });
      await expect(pending).rejects.toMatchObject({ code: "STORAGE_ERROR", message: "PostgreSQL transaction recovery failed", details: undefined });
      expect(discarded).toEqual([true]);
    });
  }

  it("sanitizes migration rollback failure, discards the connection and allows a fresh attempt", async () => {
    const actual = pool(); close.push(() => actual.end?.());
    let failing = true;
    const discarded: Array<boolean | Error | undefined> = [];
    const wrapper: DatabasePool = { connect: async () => {
      const client = await actual.connect();
      return { query: async (sql, values) => {
        if (failing && (sql.includes("pg_advisory_xact_lock") || sql === "ROLLBACK")) throw new Error("fictional private migration details");
        return client.query(sql, values);
      }, release: (destroy) => { discarded.push(destroy); client.release(); } };
    } };
    const store = new PostgresMemoryStore(wrapper);
    await expect(store.initialize()).rejects.toMatchObject({ code: "STORAGE_ERROR", message: "PostgreSQL transaction recovery failed", details: undefined });
    expect(discarded).toEqual([true]);
    failing = false;
    expect((await new MemoryService(store).remember(input)).current.version).toBe(1);
  });
});
