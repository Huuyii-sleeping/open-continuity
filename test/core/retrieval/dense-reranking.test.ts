import { afterEach, expect, it } from "vitest";
import { LocalCandidateReranker } from "../../../src/core/retrieval/reranking/local-reranker.js";
import { LocalDensePairVerifier } from "../../../src/core/retrieval/dense/local-pair-verifier.js";
import { DenseRetriever } from "../../../src/core/retrieval/dense/retriever.js";
import { MemoryService } from "../../../src/core/application/memory-service.js";
import { denseActor, denseAdmission, denseFixture } from "../../helpers/dense-fixture.js";
import { validateCandidateBatches } from "../../../src/core/retrieval/validation.js";
import { developmentCapabilities } from "../../../src/core/runtime/profile.js";
import { capabilitiesWithServiceSupport } from "../../../src/core/application/capabilities.js";
import type { RelevanceSession, CandidateReranker } from "../../../src/core/retrieval/reranking/contracts.js";
const fixtures: ReturnType<typeof denseFixture>[] = [];
afterEach(async () => { for (const f of fixtures.splice(0)) await f.cleanup(); });
const request = { ...denseActor, query: "fictional semantic query" }, support = { entailment: .9, neutral: .05, contradiction: .05 };
function setup(score: RelevanceSession["score"] = async (_query, docs) => docs.map(doc => doc.includes("correct") ? 8 : -3), compare?: (premise: string, hypothesis: string) => Promise<typeof support>) {
  const reranker = new LocalCandidateReranker({ modelFingerprint: "c".repeat(64), load: async () => ({ modelFingerprint: "c".repeat(64), score, close: async () => {} }) });
  const pairVerifier = new LocalDensePairVerifier({ modelFingerprint: "d".repeat(64), load: async () => ({ modelFingerprint: "d".repeat(64), compare: compare ?? (async () => support), close: async () => {} }) },
    { version: "dense-pair-v1", modelFingerprint: "d".repeat(64), minEntailment: .5, maxContradiction: .5 });
  const f = denseFixture({ mode: "hybrid", candidateSelection: "bidirectional_rescue", pairVerifier, reranking: { reranker } },
    async (texts, mode) => texts.map(text => mode === "query" ? [1, 0] : text.includes("correct") ? [.7, Math.sqrt(.51)] : [.8, .6]));
  fixtures.push(f); return { ...f, reranker, pairVerifier };
}
it("reorders by actual relevance logits and retains cosine origins through all consumers", async () => {
  const f = setup(); await f.remember("literal wrong fixture"); const correct = await f.remember("literal correct fixture"); await f.service.synchronizeDenseIndex(denseActor);
  const batch = await f.dense.retrieve(request, 0); validateCandidateBatches([batch]);
  expect(batch.ordering).toBe("cross_encoder_then_cosine_updated_at_id"); expect(batch.hits[0]).toMatchObject({ memory: { id: correct.current.id }, score: { model: "cross_encoder_logit", value: 8 },
    reranking: { applied: true, cosine: { rank: 2, value: expect.closeTo(.7, 5) } } });
  expect(batch.dense).toMatchObject({ rescue: { reason: "reranked_score_gate", generation: "reranked_vector_window" }, reranking: { chosenRoute: "reranked", baselineVerification: { limit: 4 }, rerankedVerification: { limit: 1 } } });
  expect((await f.service.recall(request)).memories[0]?.id).toBe(correct.current.id);
  expect((await f.service.context(request)).items[0]?.memoryId).toBe(correct.current.id);
  expect((await f.service.query(request)).evidence[0]?.memory.retrieval?.evidence?.[0]?.score.model).toBe("cross_encoder_logit");
  const capability = capabilitiesWithServiceSupport(developmentCapabilities(), f.service); expect(capability.retrieval.rerank).toBe(true);
  expect(capabilitiesWithServiceSupport(capability, new MemoryService(f.store)).retrieval.rerank).toBe(false);
});
it("retains the original verified candidate after a genuine reranked rejection", async () => {
  const f = setup(async (_q, docs) => docs.map(doc => doc.includes("rejected") ? 8 : -1), async premise => premise.includes("rejected") ? { entailment: .01, neutral: .01, contradiction: .98 } : support);
  const original = await f.remember("original fixture"); await f.remember("correct rejected fixture"); await f.service.synchronizeDenseIndex(denseActor);
  const batch = await f.dense.retrieve(request, 0); validateCandidateBatches([batch]);
  expect(batch.hits[0]?.memory.id).toBe(original.current.id); expect(batch.hits[0]?.score.model).toBe("cosine_similarity"); expect(batch.hits[0]?.reranking?.applied).toBe(false);
  expect(batch.dense?.reranking).toMatchObject({ chosenRoute: "baseline", rerankedVerification: { reason: "pair_rejected" } });
});
it("does not reinterpret a negative logit as an automatic rejection or a probability", async () => {
  const f = setup(async (_q, docs) => docs.map(doc => doc.includes("correct") ? -2 : -7)); await f.remember("wrong fixture"); const correct = await f.remember("correct fixture"); await f.service.synchronizeDenseIndex(denseActor);
  const batch = await f.dense.retrieve(request, 0); expect(batch.hits[0]?.memory.id).toBe(correct.current.id); expect(batch.hits[0]?.score.value).toBe(-2); validateCandidateBatches([batch]);
});
it("keeps incomplete inference unavailable and never turns it into baseline success", async () => {
  const f = setup(async () => { throw new Error("fictional unavailable model"); }); await f.remember("original fixture"); await f.service.synchronizeDenseIndex(denseActor);
  const batch = await f.dense.retrieve(request, 0); expect(batch.hits).toEqual([]); expect(batch.dense?.reason).toBe("reranking_unavailable");
});
it("rejects invalid mode, small windows and unsupported verification budgets before inference", () => {
  const f = setup();
  for (const extra of [{ candidateSelection: "score_gate" as const }, { reranking: { reranker: f.reranker, candidateLimit: 2 } }, { reranking: { reranker: f.reranker, verificationLimit: 5 } }])
    expect(() => new DenseRetriever(f.index, f.provider, { admission: denseAdmission, mode: "hybrid", candidateSelection: "bidirectional_rescue", pairVerifier: f.pairVerifier, reranking: { reranker: f.reranker }, ...extra })).toThrow(/policy/);
  expect(f.calls.load).toBe(0);
});
it("filters ineligible higher-scored rows before exposing text to a reranker", async () => {
  const inspected: string[] = []; const f = setup(async (_q, docs) => { inspected.push(...docs); return docs.map(() => 8); }); const allowed = await f.remember("allowed fixture");
  for (const extra of [{ userId: "fictional-other" }, { scope: "agent", agentId: "fictional-other" }, { scope: "task", taskId: "fictional-other" }, { sensitivity: "private" }, { userConfirmed: false }])
    await f.remember("forbidden fixture", extra);
  for (const actor of [denseActor, { ...denseActor, userId: "fictional-other" }, { ...denseActor, agentId: "fictional-other", taskId: "fictional-other" }])
    await f.service.synchronizeDenseIndex({ ...actor, includePrivate: true });
  expect((await f.service.recall(request)).memories.map(memory => memory.id)).toEqual([allowed.current.id]);
  expect((await f.service.context(request)).items.map(item => item.memoryId)).toEqual([allowed.current.id]);
  expect((await f.service.query(request)).contextPack.items.map(item => item.memoryId)).toEqual([allowed.current.id]); expect(inspected.join(" ")).not.toContain("forbidden");
});
it("rejects stale source/index changes and unbound model scores", async () => {
  let change: (() => Promise<void>) | undefined; const f = setup(async (_q, docs) => { await change?.(); return docs.map(() => 8); });
  await f.remember("original fixture"); await f.service.synchronizeDenseIndex(denseActor);
  change = async () => { change = undefined; await f.remember("changed fixture", { key: "fictional-0" }); };
  expect((await f.dense.retrieve(request, 0)).dense?.reason).toBe("index_changed");
  await f.service.synchronizeDenseIndex(denseActor);
  const original = f.reranker.rank.bind(f.reranker); f.reranker.rank = async (...args) => { const result = await original(...args); result.scores[0]!.memoryVersion = 99; return result; };
  expect((await f.dense.retrieve(request, 0)).dense?.reason).toBe("unavailable");
});
it("keeps post-retrieval invalidation diagnostic and never lets it promote stale hits", async () => {
  const f = setup(); await f.remember("wrong fixture"); await f.remember("correct fixture"); await f.service.synchronizeDenseIndex(denseActor);
  const service = new MemoryService(f.store, { experimentalDense: { mode: f.dense.mode, fingerprint: () => f.dense.fingerprint(), retrieve: async (...args) => {
    const batch = await f.dense.retrieve(...args); await f.remember("changed current fixture", { key: "fictional-0" }); return batch;
  } } });
  const result = await service.recall(request); expect(result.memories).toEqual([]);
  expect(result.retrieval?.channelResults?.at(-1)?.dense?.reason).toBe("index_changed");
});
it("binds reranker runtime, window and support limits to cursors and rejects forged receipts", async () => {
  const f = setup(); await f.remember("literal wrong fixture"); await f.remember("literal correct fixture"); await f.service.synchronizeDenseIndex(denseActor);
  const batch = await f.dense.retrieve(request, 0); validateCandidateBatches([batch]); batch.hits[0]!.reranking!.score.memoryVersion = 9;
  expect(() => validateCandidateBatches([batch])).toThrow(/reranking/);
  const page = await f.service.recall({ ...request, query: "literal", limit: 1 }); expect(page.nextCursor).toBeDefined();
  const alternate = new DenseRetriever(f.index, f.provider, { admission: denseAdmission, mode: "hybrid", candidateSelection: "bidirectional_rescue", pairVerifier: f.pairVerifier,
    reranking: { reranker: f.reranker, candidateLimit: 10, verificationLimit: 2 } });
  try { await expect(new MemoryService(f.store, { experimentalDense: alternate }).recall({ ...request, query: "literal", limit: 1, cursor: page.nextCursor! })).rejects.toThrow(/cursor/i); }
  finally { await alternate.close(); }
});
