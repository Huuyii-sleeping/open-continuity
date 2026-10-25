import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { DataType, newDb } from "pg-mem";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CandidateRetrieval } from "../src/core/candidate-search.js";
import { InMemoryStore, JsonFileStore } from "../src/core/memory-store.js";
import { MemoryService } from "../src/core/memory-service.js";
import { SqliteMemoryStore } from "../src/sqlite/sqlite-memory-store.js";
import { PostgresMemoryStore, type DatabasePool } from "../src/postgres/postgres-memory-store.js";
import { candidateConformance } from "./helpers/candidate-conformance.js";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { vi.useRealTimers(); for (const cleanup of cleanups.splice(0)) await cleanup(); });
for (const backend of ["inmemory","json","sqlite","postgres-pg-mem"] as const) {
  candidateConformance(backend, async () => {
    const directory = mkdtempSync(join(tmpdir(),"oc-fictional-candidates-"));
    let pool: DatabasePool | undefined;
    let store: InMemoryStore | JsonFileStore | SqliteMemoryStore | PostgresMemoryStore;
    if (backend === "sqlite") store = new SqliteMemoryStore(join(directory,"fictional.db"));
    else if (backend === "json") store = new JsonFileStore(join(directory,"fictional.json"));
    else if (backend === "inmemory") store = new InMemoryStore();
    else {
      const db = newDb({ autoCreateForeignKeyIndices: true });
      db.public.registerFunction({ name: "pg_advisory_xact_lock", args: [DataType.integer], returns: DataType.integer, implementation: () => 1 });
      db.public.registerFunction({ name: "strpos", args: [DataType.text,DataType.text], returns: DataType.integer, implementation: (text: string,part: string) => text.indexOf(part)+1 });
      const adapter = db.adapters.createPg(); pool = new adapter.Pool(); store = new PostgresMemoryStore(pool!);
    }
    const service = new MemoryService(store);
    cleanups.push(async () => { try { await service.close(); await pool?.end?.(); } finally { rmSync(directory,{ recursive: true, force: true }); } });
    return { store, service };
  });
}
describe("SQLite native candidate ranking", () => {
  const actor = { userId: "fictional-bm25-user", agentId: "fictional-reader" };
  async function runtime() {
    const directory = mkdtempSync(join(tmpdir(),"oc-fictional-bm25-")),path = join(directory,"fictional.db");
    const store = new SqliteMemoryStore(path), service = new MemoryService(store);
    cleanups.push(async () => { await service.close(); rmSync(directory,{ recursive: true, force: true }); });
    return { store,service,path };
  }
  it("uses real BM25 before recency and exactly agrees with native SQLite scores", async () => {
    const { store,service,path } = await runtime();
    vi.useFakeTimers({ toFake: ["Date"] }); vi.setSystemTime(new Date("2031-01-01T00:00:00Z"));
    await service.remember({ ...actor, key: "fictional-focused", value: "sqlite sqlite sqlite", kind: "decision", idempotencyKey: "focused" });
    vi.setSystemTime(new Date("2031-01-02T00:00:00Z"));
    await service.remember({ ...actor, key: "fictional-diluted", value: "sqlite " + "unrelated filler ".repeat(100), kind: "decision", idempotencyKey: "diluted" });
    vi.useRealTimers();
    const result = await store.searchCandidates({ ...actor, channel: "full_text", query: "sqlite" });
    expect(result.hits.map(h => h.memory.key)).toEqual(["fictional-focused","fictional-diluted"]);
    expect(result.hits[0]!.score.value).toBeLessThan(result.hits[1]!.score.value!);
    expect(result.hits[0]).toMatchObject({ rankMeaning: "relevance", score: { model: "fts5_bm25", direction: "lower_is_better" } });
    const db = new DatabaseSync(path);
    try {
      const native = db.prepare('SELECT memory_id, bm25(memories_fts) AS score FROM memories_fts WHERE memories_fts MATCH ? ORDER BY score').all('"sqlite"');
      expect(result.hits.map(h => [h.memory.id,h.score.value])).toEqual(native.map(r => [r.memory_id,r.score]));
    } finally { db.close(); }
    // The staged path does not silently change public/legacy chronological lookup.
    expect((await store.recall({ ...actor, query: "sqlite", includePrivate: false, limit: 20 })).memories[0]!.key).toBe("fictional-diluted");
  });
  it("ANDs literal terms across columns and applies short-term constraints without padding misses", async () => {
    const { store,service } = await runtime();
    for (const [key,value] of [["sqlite-design","fictional WAL reason xy"],["sqlite-other","fictional WAL only"],["irrelevant","fictional xy only"]]) {
      await service.remember({ ...actor,key: key!,value,kind: "decision",idempotencyKey: key! });
    }
    expect((await store.searchCandidates({ ...actor,channel: "full_text",query: "WAL sqlite xy" })).hits.map(h => h.memory.key)).toEqual(["sqlite-design"]);
    expect((await store.searchCandidates({ ...actor,channel: "full_text",query: "sqlite absent" })).hits).toEqual([]);
  });
  it("labels two-character Unicode lookup as an unscored literal fallback", async () => {
    const { store,service } = await runtime();
    await service.remember({ ...actor,key: "fictional-cn",value: "虚构数据库选择",kind: "decision",idempotencyKey: "cn" });
    const result = await store.searchCandidates({ ...actor,channel: "full_text",query: "数据" });
    expect(result).toMatchObject({ implementation: "sqlite_literal_fallback", ordering: "updated_at_id" });
    expect(result.hits[0]).toMatchObject({ rankMeaning: "match_order",score: { model: "none",value: null },match: { type: "literal_substring" } });
  });
  it("maps SQLite query failure to a safe error rather than a successful empty batch", async () => {
    const { store,service,path } = await runtime();
    await service.remember({ ...actor,key: "fictional",value: "sqlite",kind: "decision",idempotencyKey: "one" });
    const db = new DatabaseSync(path); db.exec("DROP TABLE memories_fts"); db.close();
    expect(() => store.searchCandidates({ ...actor,channel: "full_text",query: "sqlite" })).toThrow(expect.objectContaining({ code: "STORAGE_ERROR",message: "SQLite operation failed" }));
  });
});
it("candidate orchestration never swallows a failed channel or silently fuses results", async () => {
  const store = { searchCandidates: vi.fn().mockRejectedValue(new Error("fictional failure")) };
  await expect(new CandidateRetrieval(store).retrieve({ userId: "fictional",agentId: "fictional",query: "needle" })).rejects.toThrow("fictional failure");
  expect(store.searchCandidates).toHaveBeenCalledTimes(1);
  await expect(new CandidateRetrieval(store).retrieve({ userId: "fictional",agentId: "fictional" },["exact","exact"])).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
});
