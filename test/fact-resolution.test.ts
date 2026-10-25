import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { DataType, newDb } from "pg-mem";
import { afterEach, describe, expect, it, vi } from "vitest";
import { InMemoryStore, JsonFileStore } from "../src/core/memory-store.js";
import { MemoryService } from "../src/core/memory-service.js";
import { SqliteMemoryStore } from "../src/sqlite/sqlite-memory-store.js";
import { PostgresMemoryStore } from "../src/postgres/postgres-memory-store.js";
import { assessFactGroup } from "../src/core/fact-resolution.js";
import { exportMemoryPackage, importMemoryPackage } from "../src/package/memory-package.js";
import { factConformance } from "./helpers/fact-conformance.js";
import { rememberInputSchema } from "../src/shared/types.js";
import { exportSqliteToJson, importJsonToSqlite, readJsonLedger } from "../src/sqlite/transfer.js";
import { decodeEventLedger } from "../src/core/event-ledger.js";
import { buildHttpApp } from "../src/http/app.js";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { vi.useRealTimers(); for (const cleanup of cleanups.splice(0)) await cleanup(); });
for (const backend of ["inmemory", "json", "sqlite", "postgres-pg-mem"] as const) {
  factConformance(backend, async () => {
    const directory = mkdtempSync(join(tmpdir(), "oc-fictional-facts-"));
    let store;
    if (backend === "sqlite") store = new SqliteMemoryStore(join(directory, "fictional.db"));
    else if (backend === "json") store = new JsonFileStore(join(directory, "fictional.json"));
    else if (backend === "inmemory") store = new InMemoryStore();
    else {
      const db = newDb();
      db.public.registerFunction({ name: "pg_advisory_xact_lock", args: [DataType.integer], returns: DataType.integer, implementation: () => 1 });
      db.public.registerFunction({ name: "strpos", args: [DataType.text, DataType.text], returns: DataType.integer, implementation: (text: string, part: string) => text.indexOf(part) + 1 });
      const pool = new (db.adapters.createPg().Pool)();
      store = new PostgresMemoryStore(pool);
      cleanups.push(async () => { await pool.end(); });
    }
    const service = new MemoryService(store);
    cleanups.push(async () => { await service.close(); rmSync(directory, { recursive: true, force: true }); });
    return { store, service };
  });
}
describe("fact time, snapshot and compatibility boundaries", () => {
  const actor = { userId: "fictional-time-user", agentId: "fictional-reader" };
  const input = { ...actor, key: "fictional", value: "fictional sqlite", kind: "decision" as const, userConfirmed: true, expectedVersion: 0, idempotencyKey: "fictional" };
  it("uses inclusive start/exclusive end and does not let future replacements retire present facts", async () => {
    const service = new MemoryService(new InMemoryStore());
    const old = await service.remember({ ...input, fact: { group: "fictional", validUntil: "2031-01-02T00:00:00Z" } });
    const next = await service.remember({ ...input, key: "fictional-next", idempotencyKey: "fictional-next", fact: { group: "fictional", validFrom: "2031-01-02T00:00:00Z", supersedes: [{ memoryId: old.current.id, sourceEventId: old.current.sourceEventId, version: 1 }] } });
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2031-01-01T23:59:59Z"));
    expect((await service.recall({ ...actor, query: "sqlite" })).memories.map(memory => memory.id)).toEqual([old.current.id]);
    vi.setSystemTime(new Date("2031-01-02T00:00:00Z"));
    expect((await service.recall({ ...actor, query: "sqlite" })).memories.map(memory => memory.id)).toEqual([next.current.id]);
    await expect(service.remember({ ...input, idempotencyKey: "fictional-invalid", fact: { group: "fictional", validFrom: "2032-01-01T00:00:00Z", validUntil: "2031-01-01T00:00:00Z" } })).rejects.toThrow();
  });
  it("rejects cyclic replacement claims and mixed snapshots", async () => {
    const store = new InMemoryStore(), service = new MemoryService(store);
    const a = await service.remember({ ...input, fact: { group: "fictional" } });
    const b = await service.remember({ ...input, key: "fictional-b", idempotencyKey: "fictional-b", fact: { group: "fictional" } });
    const rows = [a.current, b.current].map(memory => structuredClone(memory));
    rows[0]!.fact!.supersedes = [{ memoryId: b.current.id, sourceEventId: b.current.sourceEventId, version: 1 }];
    rows[1]!.fact!.supersedes = [{ memoryId: a.current.id, sourceEventId: a.current.sourceEventId, version: 1 }];
    expect([...assessFactGroup(rows, "2031-01-01T00:00:00Z").values()].every(decision => decision.reason === "replacement_cycle")).toBe(true);
    vi.spyOn(store, "readFactGroup").mockImplementation(() => ({ memories: [{ ...a.current, value: "fictional altered" }, b.current], truncated: false }));
    await expect(service.recall({ ...actor, query: "sqlite" })).rejects.toMatchObject({ code: "STORAGE_ERROR", message: "Inconsistent fact group evidence" });
  });
  it("rejects changed fact budgets on continuation and exposes unsupported legacy stores", async () => {
    const store = new InMemoryStore(), service = new MemoryService(store);
    for (const key of ["fictional-a", "fictional-b"]) await service.remember({ ...input, key, idempotencyKey: key });
    const first = await service.recall({ ...actor, query: "sqlite", limit: 1 });
    await expect(new MemoryService(store, { factGroupLimit: 1 }).recall({ ...actor, query: "sqlite", cursor: first.nextCursor! })).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
    await service.remember({ ...input, key: "fictional-c", idempotencyKey: "fictional-c", fact: { group: "fictional" } });
    const custom = new MemoryService({ appendRemember: input => store.appendRemember(input), appendForget: (...args) => store.appendForget(...args), history: input => store.history(input), recall: input => store.recall(input) });
    const result = await custom.recall({ ...actor, query: "sqlite" });
    expect(result.memories).toHaveLength(2);
    expect(result.retrieval?.factReview?.omitted[0]?.assessment).toMatchObject({ coverage: "unsupported", reason: "store_unsupported" });
  });
  it("keeps fact persistence atomic when the later event projection fails", async () => {
    const directory = mkdtempSync(join(tmpdir(), "oc-fictional-fact-failure-")), path = join(directory, "fictional.db");
    const store = new SqliteMemoryStore(path), service = new MemoryService(store), db = new DatabaseSync(path);
    cleanups.push(async () => { db.close(); await service.close(); rmSync(directory, { recursive: true, force: true }); });
    const before = await service.remember({ ...input, fact: { group: "fictional" } });
    db.exec("CREATE TRIGGER fictional_fault BEFORE UPDATE OF fact ON memory_events BEGIN SELECT RAISE(ABORT, 'fictional failure'); END");
    await expect(service.remember({ ...input, expectedVersion: 1, idempotencyKey: "fictional-update", value: "fictional updated", fact: { group: "fictional-new" } })).rejects.toMatchObject({ code: "STORAGE_ERROR" });
    expect((await service.recall(actor)).memories[0]).toEqual(before.current);
    expect((await service.history(actor)).events).toHaveLength(1);
  });
  it("preserves fact declarations and references through package and versioned JSON", async () => {
    const directory = mkdtempSync(join(tmpdir(), "oc-fictional-fact-package-"));
    cleanups.push(async () => { rmSync(directory, { recursive: true, force: true }); });
    const sourcePath = join(directory, "source.db"), targetPath = join(directory, "target.db"), packagePath = join(directory, "package");
    const source = new SqliteMemoryStore(sourcePath), service = new MemoryService(source);
    const old = await service.remember({ ...input, fact: { group: "fictional" } });
    const next = await service.remember({ ...input, key: "fictional-next", idempotencyKey: "fictional-next", fact: { group: "fictional", supersedes: [{ memoryId: old.current.id, sourceEventId: old.current.sourceEventId, version: 1 }] } });
    await service.close();
    expect(exportMemoryPackage(sourcePath, packagePath).version).toBe("1.1");
    importMemoryPackage(packagePath, targetPath, { targetUserId: "fictional-imported-user" });
    const target = new SqliteMemoryStore(targetPath);
    try {
      expect(target.exportEvents()[1]?.fact).toEqual(next.current.fact);
      const recalled = await new MemoryService(target).recall({ userId: "fictional-imported-user", agentId: actor.agentId, query: "sqlite" });
      expect(recalled.memories.map(memory => memory.id)).toEqual([next.current.id]);
    } finally { target.close(); }
    const jsonPath = join(directory, "fictional.json"), json = new MemoryService(new JsonFileStore(jsonPath));
    await json.remember({ ...input, fact: { group: "fictional" } });
    const raw = JSON.parse(readFileSync(jsonPath, "utf8"));
    expect(raw.schemaVersion).toBe(2);
    expect(raw.events).toBeUndefined(); // Old array-only readers fail, rather than silently stripping facts.
    expect((await new MemoryService(new JsonFileStore(jsonPath)).recall(actor)).memories[0]?.fact?.group).toBe("fictional");
    const transferredPath = join(directory, "transferred.db"), exportedPath = join(directory, "exported.json");
    expect(importJsonToSqlite(jsonPath, transferredPath)).toBe(1);
    expect(exportSqliteToJson(transferredPath, exportedPath)).toBe(1);
    expect(JSON.parse(readFileSync(exportedPath, "utf8")).schemaVersion).toBe(2);
    expect(readJsonLedger(exportedPath)[0]?.fact?.group).toBe("fictional");
    expect(() => decodeEventLedger({ events: raw.eventsV2 })).toThrow("Fact declarations require event ledger v2");
  });
  it("rechecks accumulated query claims before Context when a sibling changes mid-query", async () => {
    const store = new InMemoryStore(), service = new MemoryService(store);
    await service.remember({ ...input, fact: { group: "fictional" } });
    const read = store.readFactGroup.bind(store);
    let calls = 0;
    vi.spyOn(store, "readFactGroup").mockImplementation(request => {
      if (++calls === 2) store.appendRemember(rememberInputSchema.parse({ ...input, key: "fictional-new", value: "fictional postgres", idempotencyKey: "fictional-new", fact: { group: "fictional" } }));
      return read(request);
    });
    const result = await service.query({ ...actor, query: "sqlite" });
    expect(result.evidence).toEqual([]);
    expect(result.contextPack.context).toBe("");
    expect(result.sufficiency.status).toBe("insufficient");
    expect(result.factReview?.omitted[0]?.assessment.status).toBe("conflict");
  });
  it("does not collapse fact identities containing colon separators during package materialization", async () => {
    const directory = mkdtempSync(join(tmpdir(), "oc-fictional-fact-identity-"));
    cleanups.push(async () => { rmSync(directory, { recursive: true, force: true }); });
    const path = join(directory, "source.db"), packagePath = join(directory, "package"), targetPath = join(directory, "target.db");
    const service = new MemoryService(new SqliteMemoryStore(path));
    await service.remember({ ...input, scope: "task", taskId: "fictional:a", key: "b", idempotencyKey: "fictional-a", fact: { group: "fictional" } });
    await service.remember({ ...input, scope: "task", taskId: "fictional", key: "a:b", value: "fictional postgres", idempotencyKey: "fictional-b", fact: { group: "fictional" } });
    await service.close();
    expect(exportMemoryPackage(path, packagePath).counts.memories).toBe(2);
    importMemoryPackage(packagePath, targetPath);
    const target = new MemoryService(new SqliteMemoryStore(targetPath));
    try {
      expect((await target.recall({ ...actor, taskId: "fictional:a" })).memories.map(memory => memory.value)).toEqual(["fictional sqlite"]);
      expect((await target.recall({ ...actor, taskId: "fictional" })).memories.map(memory => memory.value)).toEqual(["fictional postgres"]);
    } finally { await target.close(); }
  });
  it("propagates group lookup failures rather than returning empty success", async () => {
    const store = new InMemoryStore(), service = new MemoryService(store);
    await service.remember({ ...input, fact: { group: "fictional" } });
    vi.spyOn(store, "readFactGroup").mockImplementation(() => { throw new Error("fictional driver failure"); });
    await expect(service.recall({ ...actor, query: "sqlite" })).rejects.toThrow("fictional driver failure");
  });
  it("rejects legacy fact writes before mutation and advertises unsupported capability", async () => {
    const store = new InMemoryStore(), append = vi.fn(parsed => store.appendRemember(parsed));
    const legacy = new MemoryService({ appendRemember: append, appendForget: (...args) => store.appendForget(...args), history: parsed => store.history(parsed), recall: parsed => store.recall(parsed) });
    await expect(legacy.remember({ ...input, fact: { group: "fictional" } })).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
    expect(append).not.toHaveBeenCalled();
    const app = buildHttpApp(legacy); await app.ready();
    try {
      expect((await app.inject({ method: "GET", url: "/v1/capabilities" })).json()).toMatchObject({ memory: { evolution: { factDeclarations: false } }, retrieval: { factPolicy: null, factGroupLimit: 0 } });
    } finally { await app.close(); }
  });
  it("does not silently accept a custom store that drops an approved declaration", async () => {
    const store = new InMemoryStore();
    const custom = new MemoryService({ appendRemember: parsed => store.appendRemember({ ...parsed, fact: undefined }),
      appendForget: (...args) => store.appendForget(...args), history: parsed => store.history(parsed), recall: parsed => store.recall(parsed), readFactGroup: request => store.readFactGroup(request) });
    await expect(custom.remember({ ...input, fact: { group: "fictional" } })).rejects.toMatchObject({ code: "STORAGE_ERROR", message: "Store violated the fact declaration contract" });
  });
});
