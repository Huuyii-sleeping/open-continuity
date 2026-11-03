import { afterEach, expect, it } from "vitest";
import { LocalCandidateReranker } from "../../../src/core/retrieval/reranking/local-reranker.js";
import { relevanceHash, validateRelevanceReceipt } from "../../../src/core/retrieval/reranking/validation.js";
import type { RelevanceRequest, RelevanceSession } from "../../../src/core/retrieval/reranking/contracts.js";
const values: LocalCandidateReranker[] = [], model = "c".repeat(64);
afterEach(async () => { for (const v of values.splice(0)) await v.close(); });
function request(extra: Partial<RelevanceRequest> = {}): RelevanceRequest { return { query: "fictional query", queryFingerprint: relevanceHash("fictional query"), accessFingerprint: "a".repeat(64),
  candidates: [{ memoryId: "fictional-memory", sourceEventId: "fictional-event", memoryVersion: 1, contentFingerprint: relevanceHash("fictional fact"), text: "fictional fact" }], ...extra }; }
function setup(score: RelevanceSession["score"] = async () => [3], policy: ConstructorParameters<typeof LocalCandidateReranker>[1] = {}, fingerprint = model) {
  const calls = { load: 0, score: 0, close: 0 };
  const v = new LocalCandidateReranker({ modelFingerprint: model, load: async () => { calls.load++; return { modelFingerprint: fingerprint,
    score: async (...args) => { calls.score++; return score(...args); }, close: async () => { calls.close++; } }; } }, policy); values.push(v); return { v, calls };
}
it("binds relevance logits and caches to source version, query, content and access", async () => {
  const { v, calls } = setup(); const first = await v.rank(request()); validateRelevanceReceipt(request(), first, v);
  expect(first).toMatchObject({ status: "scored", meaning: "relative_query_document_relevance_logit", scores: [{ value: 3, memoryVersion: 1 }] });
  expect((await v.rank(request())).cache).toBe("hit"); expect(calls.score).toBe(1);
  for (const extra of [{ memoryVersion: 2 }, { sourceEventId: "new-event" }]) await v.rank(request({ candidates: [{ ...request().candidates[0]!, ...extra }] }));
  await v.rank(request({ accessFingerprint: "b".repeat(64) })); expect(calls.score).toBe(4);
  expect(() => validateRelevanceReceipt(request(), { ...first, accessFingerprint: "b".repeat(64) }, v)).toThrow(/Unbound/);
  expect(() => validateRelevanceReceipt(request(), { ...first, scores: [] }, v)).toThrow(/Unbound/);
});
it("rejects malformed bindings and oversized batches before loading a model", async () => {
  const { v, calls } = setup();
  for (const input of [request({ query: "changed" }), request({ candidates: [] }), request({ candidates: Array.from({ length: 21 }, (_, i) => ({ ...request().candidates[0]!, memoryId: `memory-${i}` })) }),
    request({ candidates: [{ ...request().candidates[0]!, memoryVersion: 1.5 }] })]) await expect(v.rank(input)).rejects.toThrow();
  expect(calls.load).toBe(0);
});
it.each([{ scores: [] }, { scores: [NaN] }, { scores: [1, 2] }])("rejects missing, nonfinite or extra model scores %j", async ({ scores }) => {
  const { v } = setup(async () => scores); await expect(v.rank(request())).rejects.toThrow(/scores/); expect(v.status().cacheEntries).toBe(0);
});
it("snapshots bindings while scoring and never retains caller text in cached receipts", async () => {
  let resolve: ((values: readonly number[]) => void) | undefined;
  const { v } = setup(async () => new Promise(done => { resolve = done; }));
  const input = request(), pending = v.rank(input); while (!resolve) await Promise.resolve();
  input.candidates[0]!.memoryVersion = 99; input.candidates[0]!.text = "changed caller text"; resolve([2]);
  const result = await pending; expect(result.scores[0]?.memoryVersion).toBe(1); expect(JSON.stringify(result)).not.toContain("fictional fact");
  expect(() => validateRelevanceReceipt(input, result, v)).toThrow();
});
it("keeps timed-out computations in capacity accounting and drains them before closing", async () => {
  let release: (() => void) | undefined; const pending = new Promise<void>(resolve => { release = resolve; });
  const { v, calls } = setup(async () => { await pending; return [2]; }, { timeoutMs: 5, maxPending: 1 }); await v.warmup();
  expect(await v.rank(request())).toMatchObject({ status: "unavailable", scores: [] }); expect(v.status().pending).toBe(1);
  expect((await v.rank(request())).status).toBe("unavailable"); expect(calls.score).toBe(1);
  let closed = false; const closing = v.close().then(() => { closed = true; }); await new Promise(resolve => setTimeout(resolve, 10)); expect(closed).toBe(false);
  release!(); await closing; expect(calls.close).toBe(1); expect(v.status().cacheEntries).toBe(0);
});
it("rejects a mismatched loaded model without scoring and releases it", async () => {
  const { v, calls } = setup(undefined, {}, "d".repeat(64)); await expect(v.rank(request())).rejects.toThrow(/identity/);
  expect(calls.score).toBe(0); await v.close(); expect(calls.close).toBe(1);
});
it("bounds verdict storage and expires cached scores without keeping query or memory text", async () => {
  const { v } = setup(undefined, { cacheEntries: 1, cacheTtlMs: 10 }); await v.rank(request()); await v.rank(request({ accessFingerprint: "b".repeat(64) }));
  expect(v.status().cacheEntries).toBe(1); await new Promise(resolve => setTimeout(resolve, 15)); expect(v.status().cacheEntries).toBe(0);
});
