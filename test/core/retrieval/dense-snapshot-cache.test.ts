import { DatabaseSync } from "node:sqlite";
import { afterEach, expect, it, vi } from "vitest";
import { denseActor, denseFixture } from "../../helpers/dense-fixture.js";
import { DenseSnapshotCache } from "../../../src/core/retrieval/dense/snapshot-cache.js";
import { recallInputSchema } from "../../../src/shared/types.js";

const fixtures: ReturnType<typeof denseFixture>[] = [];
afterEach(async () => { for (const f of fixtures.splice(0)) await f.cleanup(); vi.useRealTimers(); });
function setup(...args: Parameters<typeof denseFixture>) { const f = denseFixture(...args); fixtures.push(f); return f; }
const request = { ...denseActor, query: "fictional semantic question", limit: 2 };
it("reads vector projections once, preserves exact score/rank and hydrates only the best references", async () => {
  const f = setup({ mode: "hybrid" }); for (let i = 0; i < 105; i++) await f.remember(`fictional fact ${i}`);
  await f.service.synchronizeDenseIndex(denseActor); await f.service.synchronizeDenseIndex(denseActor);
  const projection = vi.spyOn(f.index, "scanVectors"), full = vi.spyOn(f.index, "scan"), current = vi.spyOn(f.index, "readCurrent");
  const cold = await f.service.recall(request), warm = await f.service.recall(request);
  const stable = (result: typeof warm) => result.memories.map(memory => ({ id: memory.id, sourceEventId: memory.sourceEventId, version: memory.version, value: memory.value, channels: memory.retrieval?.channels, ranks: memory.retrieval?.ranks, evidence: memory.retrieval?.evidence }));
  expect(stable(warm)).toEqual(stable(cold)); expect(projection).toHaveBeenCalledTimes(1); expect(full).not.toHaveBeenCalled();
  expect(current.mock.calls.every(call => call[1].length === 100)).toBe(true);
  expect(cold.retrieval?.channelResults?.at(-1)?.dense?.ranking).toMatchObject({ cache: "miss", populationCount: 105, hydratedCount: 100 });
  expect(warm.retrieval?.channelResults?.at(-1)?.dense?.ranking).toMatchObject({ cache: "hit" });
});
it("invalidates cached projections on update, approval withdrawal and forget", async () => {
  const f = setup(); const first = await f.remember("current"), other = await f.remember("unrelated"); await f.service.synchronizeDenseIndex(denseActor);
  expect((await f.service.recall(request)).memories[0]?.id).toBe(first.current.id);
  await f.remember("updated", { key: first.current.key });
  expect((await f.service.recall(request)).retrieval?.channelResults?.at(-1)?.dense?.reason).toBe("index_incomplete");
  await f.service.synchronizeDenseIndex(denseActor); expect((await f.service.recall(request)).memories[0]?.version).toBe(2);
  await f.remember("withdrawn", { key: first.current.key, userConfirmed: false }); expect((await f.service.recall(request)).memories).toEqual([]);
  await f.service.forget({ ...denseActor, memoryId: other.current.id }); expect((await f.service.recall(request)).memories).toEqual([]);
  expect(f.dense.status().vectorCache.entries).toBe(0);
});
it("includes user, agent, task, private and explicit filters in cache identity", () => {
  const cache = new DenseSnapshotCache(); const base = recallInputSchema.parse(denseActor);
  const variations = [{ userId: "other" }, { agentId: "other" }, { taskId: "other" }, { includePrivate: true }, { key: "key" }, { kind: "decision" as const }, { scope: "task" as const }];
  const keys = [base, ...variations.map(value => ({ ...base, ...value }))].map(value => cache.key(value, "revision", "model", 10));
  expect(new Set(keys).size).toBe(keys.length); cache.clear();
});
it("never reuses an includePrivate snapshot in public retrieval", async () => {
  const f = setup(); await f.remember("current secret", { sensitivity: "private" }); await f.remember("unrelated");
  await f.service.synchronizeDenseIndex({ ...denseActor, includePrivate: true });
  expect((await f.service.recall({ ...request, includePrivate: true })).memories).toHaveLength(1);
  expect((await f.service.recall(request)).memories).toHaveLength(0);
});
it("supports a zero cache budget and still uses streaming projections", async () => {
  const f = setup({ snapshotCache: { maxBytes: 0 } }); await f.remember("current"); await f.remember("unrelated"); await f.service.synchronizeDenseIndex(denseActor);
  const projection = vi.spyOn(f.index, "scanVectors"); await f.service.recall(request); await f.service.recall(request);
  expect(projection).toHaveBeenCalledTimes(2); expect(f.dense.status().vectorCache.bytes).toBe(0);
});
it("wipes vector arrays on LRU eviction, TTL expiry and revision replacement", () => {
  vi.useFakeTimers(); const cache = new DenseSnapshotCache({ maxBytes: 100, maxEntries: 1, ttlMs: 10 });
  const input = recallInputSchema.parse(denseActor), key = cache.key(input, "r1", "model", 10);
  const snapshot = { revision: "r1", references: [{ id: "m", sourceEventId: "e", version: 1, updatedAt: "time" }], vectors: new Float32Array([1, 0]), normSquared: new Float64Array([1]), dimensions: 2, bytes: 16 };
  cache.put(key, snapshot); cache.put("second", { ...snapshot, vectors: new Float32Array([0, 1]), normSquared: new Float64Array([1]) });
  expect(snapshot.vectors).toEqual(new Float32Array([0, 0])); expect(cache.get(key)).toBeUndefined();
  vi.advanceTimersByTime(11); expect(cache.status().entries).toBe(0);
  cache.put(key, { ...snapshot, vectors: new Float32Array([1, 0]), normSquared: new Float64Array([1]) });
  cache.key(input, "r2", "model", 10); expect(cache.status().entries).toBe(0);
});
it("invalidates a warm cache after vector-table corruption through another connection", async () => {
  const f = setup({ mode: "hybrid" }); await f.remember("literal answer"); await f.service.synchronizeDenseIndex(denseActor);
  await f.service.recall({ ...denseActor, query: "literal" });
  const db = new DatabaseSync(f.path); db.exec("UPDATE memory_dense_vectors SET vector=x'0000'"); db.close();
  const result = await f.service.recall({ ...denseActor, query: "literal" });
  expect(result.memories).toHaveLength(1); expect(result.memories[0]?.retrieval?.channels).toEqual(["full_text"]);
  expect(f.dense.status().vectorCache.entries).toBe(0);
});
it("rejects stale projection hydration rather than returning an old cached version", async () => {
  const f = setup({ mode: "hybrid" }); await f.remember("literal answer"); await f.service.synchronizeDenseIndex(denseActor);
  await f.service.recall({ ...denseActor, query: "literal" }); vi.spyOn(f.index, "readCurrent").mockReturnValue([]);
  const result = await f.service.recall({ ...denseActor, query: "literal" }); expect(result.memories[0]?.retrieval?.channels).toEqual(["full_text"]);
});
