import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import { afterEach, describe, expect, it } from "vitest";
import { MemoryService } from "../src/core/memory-service.js";
import { PostgresMemoryStore, type DatabasePool } from "../src/postgres/postgres-memory-store.js";
import { storageConformance } from "./helpers/storage-conformance.js";
import { candidateConformance } from "./helpers/candidate-conformance.js";
import { factConformance } from "./helpers/fact-conformance.js";
import { contextSelectionConformance } from "./helpers/context-selection-conformance.js";
import { answerConformance } from "./helpers/answer-conformance.js";

// Explicit opt-in only: never use DATABASE_URL, PG* defaults or the user's service database.
const connection = process.env.OPEN_CONTINUITY_TEST_POSTGRES_URL;
const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0)) await cleanup(); });

async function runtime() {
  if (!connection) throw new Error("Explicit isolated PostgreSQL test URL is required");
  const url = new URL(connection);
  if (!["postgres:", "postgresql:"].includes(url.protocol) || !["localhost", "127.0.0.1", "[::1]"].includes(url.hostname) || !/^\/open_continuity_test(?:_[a-z0-9_]+)?$/i.test(url.pathname)) {
    throw new Error("Use a loopback open_continuity_test database for this disposable fixture");
  }
  const schema = `oc_test_${randomUUID().replaceAll("-", "")}`;
  const actual = new Pool({ connectionString: connection, max: 10, connectionTimeoutMillis: 2000, statement_timeout: 3000, lock_timeout: 2000 });
  try { await actual.query(`CREATE SCHEMA "${schema}"`); } catch { await actual.end(); throw new Error("Unable to create isolated PostgreSQL fixture schema"); }
  const faults = { event: false, deletion: false, ddl: false, lostCommit: false, rollback: false };
  let discarded = 0;
  const pool: DatabasePool = { connect: async () => {
    const client = await actual.connect();
    try { await client.query(`SET search_path TO "${schema}"`); } catch (error) { client.release(); throw error; }
    return { query: async (text, values) => {
      if ((faults.event && text.includes("INSERT INTO memory_events")) || (faults.deletion && text.startsWith("DELETE FROM memories_current")) || (faults.ddl && text.startsWith("CREATE TABLE IF NOT EXISTS memories_current")) || (faults.rollback && text === "ROLLBACK")) throw new Error("fictional private driver fault");
      const result = await client.query(text, values);
      if (faults.lostCommit && text === "COMMIT") { faults.lostCommit = false; throw new Error("fictional lost commit acknowledgement"); }
      return result;
    }, release: (destroy) => { if (destroy) discarded++; client.release(destroy); } };
  } };
  const store = new PostgresMemoryStore(pool);
  const service = new MemoryService(store);
  cleanups.push(async () => {
    try { await service.close(); await actual.query(`DROP SCHEMA "${schema}" CASCADE`); } finally { await actual.end(); }
  });
  return { store, service, pool, faults, discarded: () => discarded,
    failEvents: (value: boolean) => { faults.event = value; },
    execute: async (sql: string, values?: unknown[]) => {
      const client = await pool.connect();
      try { return await client.query(sql, values); } finally { client.release(); }
    },
    reopen: async () => { await service.close(); return new MemoryService(new PostgresMemoryStore(pool, { autoMigrate: false })); },
  };
}

describe.skipIf(!connection)("real PostgreSQL disposable storage evidence", () => {
  storageConformance("postgres-real", runtime);
  candidateConformance("postgres-real", runtime);
  contextSelectionConformance("postgres-real", runtime);
  answerConformance("postgres-real", runtime);
  factConformance("postgres-real", runtime);

  const query = { userId: "fictional-pg-concurrent", agentId: "fictional-reader" };
  const input = { userId: query.userId, agentId: "fictional-writer", key: "fictional-shared", value: { seeded: true }, kind: "user_fact" as const, idempotencyKey: "fictional-initial" };
  it("5A retains capacity for timed-out native reads and resumes only after settlement", async () => {
    const rt = await runtime(); await rt.service.remember(input);
    let delayed = true;
    const slow = new PostgresMemoryStore({ connect: async () => {
      const client = await rt.pool.connect();
      return { release: destroy => client.release(destroy), query: async (text, values) => {
        if (delayed && text.startsWith("SELECT * FROM memories_current")) {
          delayed = false; await client.query("SELECT pg_sleep(0.15)");
        }
        return client.query(text, values);
      } };
    } }, { autoMigrate: false });
    await slow.initialize();
    const service = new MemoryService(slow, {}, undefined, undefined, { defaultTimeoutMs: 10, maxPendingReads: 1 });
    await expect(service.recall(query)).rejects.toMatchObject({ code: "READ_TIMEOUT" });
    expect(service.readRuntimeStatus().pendingReads).toBe(1);
    await expect(service.recall(query)).rejects.toMatchObject({ code: "RUNTIME_BUSY" });
    // Bounded polling of this one synthetic operation, not a production retry mechanism.
    for (let n = 0; n < 100 && service.readRuntimeStatus().pendingReads; n++) await new Promise(resolve => setTimeout(resolve, 10));
    expect(service.readRuntimeStatus().pendingReads).toBe(0);
    expect((await service.recall(query)).memories).toHaveLength(1); await service.close();
  });
  it("5A server statement timeout errors remain explicit and a clean connection can recover", async () => {
    const rt = await runtime();
    const client = await rt.pool.connect();
    try {
      await client.query("SET statement_timeout = 30");
      await expect(client.query("SELECT pg_sleep(0.15)")).rejects.toMatchObject({ code: "57014" });
      await client.query("SET statement_timeout = 3000");
    } finally { client.release(); }
    await rt.service.remember(input);
    expect((await rt.service.query({ ...query, query: "fictional-shared" })).answer?.status).toBe("evidence_ready");
  });
  it("serializes concurrent merge and records the materialized audit/version chain", async () => {
    const { service } = await runtime();
    await service.remember(input);
    await Promise.all(Array.from({ length: 6 }, (_, i) => service.remember({ ...input, value: { [`fictional_${i}`]: true }, writeMode: "merge", idempotencyKey: `fictional-merge-${i}` })));
    const current = (await service.recall(query)).memories[0]!;
    expect(current.version).toBe(7);
    expect(current.value).toEqual({ seeded: true, ...Object.fromEntries(Array.from({ length: 6 }, (_, i) => [`fictional_${i}`, true])) });
    const events = (await service.history({ ...query, limit: 100 })).events.sort((a, b) => a.memoryVersion! - b.memoryVersion!);
    expect(events).toHaveLength(7);
    for (let i = 1; i < events.length; i++) expect(events[i]!.supersedes).toEqual({ eventId: events[i - 1]!.id, version: i });
    expect(events.at(-1)!.value).toEqual(current.value);
  });

  it("serializes identical request retries and admits only one CAS create", async () => {
    const { service } = await runtime();
    const receipts = await Promise.all([service.remember(input), service.remember(input)]);
    expect(receipts.filter((receipt) => receipt.duplicate)).toHaveLength(1);
    expect((await service.history(query)).events).toHaveLength(1);
    const results = await Promise.allSettled([0, 1].map((i) => service.remember({ ...input, key: "fictional-create", expectedVersion: 0, idempotencyKey: `fictional-create-${i}` })));
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(results.find((result) => result.status === "rejected")).toMatchObject({ reason: { code: "VERSION_CONFLICT" } });
  });

  it("rolls back real current-state changes when a later event write fails", async () => {
    const { service, failEvents } = await runtime();
    const before = await service.remember(input);
    failEvents(true);
    const update = { ...input, value: { changed: true }, expectedVersion: 1, idempotencyKey: "fictional-failed-update" };
    await expect(service.remember(update)).rejects.toMatchObject({ code: "STORAGE_ERROR" });
    failEvents(false);
    expect((await service.recall(query)).memories[0]).toEqual(before.current);
    expect((await service.history(query)).events).toHaveLength(1);
    expect((await service.remember(update)).current.version).toBe(2);
  });

  it("rolls back a forget event when deletion fails and can retry", async () => {
    const { service, faults } = await runtime();
    const before = await service.remember(input);
    faults.deletion = true;
    await expect(service.forget({ ...query, memoryId: before.current.id })).rejects.toMatchObject({ code: "STORAGE_ERROR", details: undefined });
    faults.deletion = false;
    expect((await service.recall(query)).memories[0]).toEqual(before.current);
    expect((await service.history(query)).events).toHaveLength(1);
    await service.forget({ ...query, memoryId: before.current.id });
    expect((await service.recall(query)).memories).toEqual([]);
    expect((await service.history(query)).events).toHaveLength(2);
  });

  it("rolls back schema DDL and migration markers, then retries initialization", async () => {
    const { store, execute, faults } = await runtime();
    faults.ddl = true;
    await expect(store.initialize()).rejects.toMatchObject({ code: "STORAGE_ERROR" });
    expect((await execute("SELECT table_name FROM information_schema.tables WHERE table_schema = current_schema()")).rows).toEqual([]);
    faults.ddl = false;
    await store.initialize();
    expect((await execute("SELECT version FROM open_continuity_schema_migrations ORDER BY version")).rows).toEqual([{ version: 1 }, { version: 2 }, { version: 3 }]);
  });

  it("refuses a future schema with and without migration without changing data", async () => {
    const { service, pool, execute } = await runtime();
    const before = await service.remember(input);
    await execute("INSERT INTO open_continuity_schema_migrations (version) VALUES (999)");
    for (const autoMigrate of [true, false]) {
      await expect(new PostgresMemoryStore(pool, { autoMigrate }).initialize()).rejects.toMatchObject({ code: "STORAGE_ERROR", message: "PostgreSQL schema version is not supported by this runtime" });
    }
    expect((await service.recall(query)).memories[0]).toEqual(before.current);
    expect((await execute("SELECT version FROM open_continuity_schema_migrations ORDER BY version")).rows).toEqual([{ version: 1 }, { version: 2 }, { version: 3 }, { version: 999 }]);
  });

  it("reconciles a committed write with a lost acknowledgement using the original idempotency key", async () => {
    const { store, service, faults } = await runtime();
    await store.initialize();
    faults.lostCommit = true;
    await expect(service.remember(input)).rejects.toMatchObject({ code: "STORAGE_ERROR" });
    const replay = await service.remember(input);
    expect(replay).toMatchObject({ duplicate: true, current: { version: 1, value: input.value } });
    expect((await service.history(query)).events).toHaveLength(1);
    expect((await service.recall(query)).memories[0]).toEqual(replay.current);
  });

  it("discards a connection after rollback failure and recovers without publishing partial state", async () => {
    const { service, faults, discarded } = await runtime();
    const before = await service.remember(input);
    const update = { ...input, value: { changed: true }, expectedVersion: 1, idempotencyKey: "fictional-rollback-discard" };
    faults.event = true; faults.rollback = true;
    await expect(service.remember(update)).rejects.toMatchObject({ code: "STORAGE_ERROR", message: "PostgreSQL transaction recovery failed", details: undefined });
    expect(discarded()).toBe(1);
    faults.event = false; faults.rollback = false;
    expect((await service.recall(query)).memories[0]).toEqual(before.current);
    expect((await service.history(query)).events).toHaveLength(1);
    expect((await service.remember(update)).current.version).toBe(2);
  });
});
