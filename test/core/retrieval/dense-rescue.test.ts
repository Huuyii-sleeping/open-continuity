import { afterEach, expect, it } from "vitest";
import { DenseRetriever } from "../../../src/core/retrieval/dense/retriever.js";
import { decideDenseRescue } from "../../../src/core/retrieval/dense/rescue.js";
import { LocalDensePairVerifier } from "../../../src/core/retrieval/dense/local-pair-verifier.js";
import type { DensePairSession, DensePairVerifier } from "../../../src/core/retrieval/dense/verification/contracts.js";
import { validateCandidateBatches } from "../../../src/core/retrieval/validation.js";
import { denseActor, denseAdmission, denseFixture } from "../../helpers/dense-fixture.js";

const fixtures: ReturnType<typeof denseFixture>[] = [];
afterEach(async () => { for (const f of fixtures.splice(0)) await f.cleanup(); });
const request = { ...denseActor, query: "fictional semantic question" };
const support = { entailment: .9, neutral: .05, contradiction: .05 }, neutral = { entailment: .05, neutral: .9, contradiction: .05 };
function verifier(compare: DensePairSession["compare"] = async (premise, hypothesis) => (premise.includes("supported") || hypothesis.includes("supported")) ? support : neutral) {
  const modelFingerprint = "c".repeat(64);
  return new LocalDensePairVerifier({ modelFingerprint, load: async () => ({ modelFingerprint, compare, close: async () => {} }) },
    { version: "dense-pair-v1", modelFingerprint, minEntailment: .5, maxContradiction: .5 });
}
function setup(pairVerifier: DensePairVerifier = verifier(), extra: Parameters<typeof denseFixture>[0] = {}) {
  const f = denseFixture({ mode: "hybrid", candidateSelection: "bidirectional_rescue", pairVerifier, ...extra }, async (texts, mode) => texts.map(text =>
    mode === "query" ? [1, 0] : text.includes("low cosine decoy") ? [.6, .8] : text.includes("supported") ? [.5, Math.sqrt(.75)] : [.8, .6]));
  fixtures.push(f); return f;
}
it("validates complete rescue windows and distinguishes mutual support from preservation", () => {
  expect(decideDenseRescue(["a", "b"], ["b"], 7, 2)).toMatchObject({ reason: "unique_mutual_support", outsideWindow: 5, windowComplete: true });
  expect(decideDenseRescue(["a", "b"], [], 2, 4).reason).toBe("no_mutual_support");
  expect(decideDenseRescue(["a", "b"], ["a", "b"], 2, 4).reason).toBe("ambiguous_mutual_support");
  expect(decideDenseRescue(["a"], [], 5, 4, "score_gate_preserved")).toMatchObject({ reason: "score_gate_preserved", windowComplete: false });
  for (const [ids, supported, population, limit] of [[[], [], 2, 4], [["a"], ["b"], 1, 4], [["a", "a"], [], 2, 4], [["a"], ["a", "a"], 1, 4], [["a"], [], 1, 0]] as const)
    expect(() => decideDenseRescue(ids, supported, population, limit)).toThrow();
});
it("requires explicit hybrid mode and a verifier with real reverse capability", async () => {
  const f = denseFixture(); fixtures.push(f); const v = verifier();
  try {
    for (const extra of [{ candidateSelection: "bidirectional_rescue" as const }, { mode: "hybrid" as const, candidateSelection: "bidirectional_rescue" as const },
      { mode: "miss_only" as const, candidateSelection: "bidirectional_rescue" as const, pairVerifier: v },
      { mode: "hybrid" as const, candidateSelection: "bidirectional_rescue" as const, pairVerifier: { policy: v.policy, fingerprint: () => v.fingerprint(), verify: v.verify.bind(v), close: () => v.close() } }])
      expect(() => new DenseRetriever(f.index, f.provider, { admission: denseAdmission, ...extra })).toThrow(/policy/);
    expect(f.calls.load).toBe(0);
  } finally { await v.close(); }
});
it("recovers a below-threshold second candidate through Recall, Context and Query", async () => {
  const f = setup(); await f.remember("decoy fixture"); const correct = await f.remember("supported fixture"); await f.service.synchronizeDenseIndex(denseActor);
  for (let repeat = 0; repeat < 3; repeat++) {
    const result = await f.service.recall(request);
    expect(result.memories.map(memory => memory.id)).toEqual([correct.current.id]);
    expect(result.memories[0]?.retrieval?.evidence?.[0]?.score).toMatchObject({ model: "cosine_similarity", value: expect.closeTo(.5, 5) });
    expect(result.retrieval?.channelResults?.at(-1)?.dense).toMatchObject({ rescue: { reason: "unique_mutual_support", windowComplete: true, outsideWindow: 0 }, verificationBudget: { attempted: 2, reverseAttempted: 1, notVerified: 0, limit: 4 }, reversePairs: [{ accepted: true, direction: "query_to_memory" }] });
  }
  expect((await f.service.context(request)).items[0]?.memoryId).toBe(correct.current.id);
  expect((await f.service.query(request)).evidence[0]?.memory.id).toBe(correct.current.id);
});
it("keeps the original policy default and its similarity threshold", async () => {
  const f = setup(verifier(), { candidateSelection: "score_gate" }); await f.remember("decoy fixture"); await f.remember("supported fixture"); await f.service.synchronizeDenseIndex(denseActor);
  const result = await f.service.recall(request); expect(result.memories).toEqual([]);
  expect(result.retrieval?.channelResults?.at(-1)?.dense?.reason).toBe("pair_rejected");
});
it("preserves a supported original top hit without running reverse or extra verification", async () => {
  let compared = 0; const f = setup(verifier(async () => { compared++; return support; }));
  const first = await f.remember("high cosine fixture"); await f.remember("supported low cosine fixture"); await f.service.synchronizeDenseIndex(denseActor);
  const batch = await f.dense.retrieve(request, 0); expect(batch.hits[0]?.memory.id).toBe(first.current.id); expect(compared).toBe(1);
  expect(batch.dense).toMatchObject({ rescue: { reason: "score_gate_preserved", windowComplete: false }, verificationBudget: { attempted: 1, reverseAttempted: 0, notVerified: 1 } });
  validateCandidateBatches([batch]);
});
it("rejects one-way support and abstains on multiple mutual candidates", async () => {
  const f = setup(verifier(async premise => premise.includes("supported") ? support : neutral));
  await f.remember("supported one fixture"); await f.service.synchronizeDenseIndex(denseActor);
  const rejected = await f.dense.retrieve(request, 0); expect(rejected.hits).toEqual([]); expect(rejected.dense?.rescue?.reason).toBe("no_mutual_support"); validateCandidateBatches([rejected]);
  const other = setup(); await other.remember("supported one fixture"); await other.remember("supported two fixture"); await other.service.synchronizeDenseIndex(denseActor);
  const ambiguous = await other.dense.retrieve(request, 0); expect(ambiguous.hits).toEqual([]); expect(ambiguous.dense?.rescue?.reason).toBe("ambiguous_mutual_support"); validateCandidateBatches([ambiguous]);
});
it("does not search around a contradicted nearest neighbour, above or below the cosine gate", async () => {
  for (const value of ["decoy fixture", "low cosine decoy fixture"]) {
    let calls = 0;
    const f = setup(verifier(async premise => { calls++; return premise.includes("decoy") ? { entailment: .01, neutral: .01, contradiction: .98 } : support; }));
    await f.remember(value); await f.remember("supported tail fixture"); await f.service.synchronizeDenseIndex(denseActor);
    const batch = await f.dense.retrieve(request, 0); expect(batch.hits).toEqual([]); expect(calls).toBe(1);
    expect(batch.dense?.rescue?.reason).toBe("top_contradiction"); validateCandidateBatches([batch]);
  }
});
it("does not add rescue candidates to an existing lexical answer", async () => {
  const f = setup(); const first = await f.remember("literal decoy fixture"); await f.remember("supported fixture"); await f.service.synchronizeDenseIndex(denseActor);
  const result = await f.service.recall({ ...request, query: "literal" }); expect(result.memories.map(memory => memory.id)).toEqual([first.current.id]);
  expect(result.retrieval?.channelResults?.at(-1)?.dense?.reason).toBe("lexical_preserved");
});
it("caps verification independently of output limit and reports unverified population", async () => {
  let compared = 0; const f = setup(verifier(async () => { compared++; return neutral; }));
  for (let i = 0; i < 7; i++) await f.remember(`decoy fixture ${i}`);
  await f.service.synchronizeDenseIndex(denseActor);
  const batch = await f.dense.retrieve({ ...request, limit: 1 }, 0);
  expect(compared).toBe(4); expect(batch.dense).toMatchObject({ verificationBudget: { limit: 4, attempted: 4, reverseAttempted: 0, notVerified: 3 }, rescue: { outsideWindow: 3, reason: "no_mutual_support" } }); validateCandidateBatches([batch]);
});
it("filters all authorization and explicit constraints before exposing text to verification", async () => {
  const inspected: string[] = []; const f = setup(verifier(async (p, h) => { inspected.push(p, h); return support; }));
  const allowed = await f.remember("supported allowed", { key: "allowed", kind: "user_fact" });
  for (const [i, extra] of [{ userId: "fictional-other" }, { scope: "agent", agentId: "fictional-other" }, { scope: "task", taskId: "fictional-other" },
    { sensitivity: "private" }, { userConfirmed: false }, { kind: "user_preference" }, { key: "other-key" }].entries())
    await f.remember("supported forbidden", { key: `forbidden-${i}`, kind: "user_fact", ...extra });
  for (const actor of [denseActor, { ...denseActor, userId: "fictional-other" }, { ...denseActor, agentId: "fictional-other", taskId: "fictional-other" }])
    await f.service.synchronizeDenseIndex({ ...actor, includePrivate: true });
  const batch = await f.dense.retrieve({ ...request, key: "allowed", kind: "user_fact", scope: "user", includePrivate: false }, 0);
  expect(batch.hits.map(hit => hit.memory.id)).toEqual([allowed.current.id]); expect(inspected.join(" ")).not.toContain("forbidden");
});
it("does not let higher-scored ineligible memories crowd out the authorized rescue window", async () => {
  const inspected: string[] = [], v = verifier(async (p, h) => { inspected.push(p, h); return support; });
  const f = denseFixture({ mode: "hybrid", candidateSelection: "bidirectional_rescue", pairVerifier: v }, async (texts, mode) => texts.map(text =>
    mode === "query" ? [1, 0] : text.includes("forbidden") ? [1, 0] : [.5, Math.sqrt(.75)])); fixtures.push(f);
  const allowed = await f.remember("supported allowed fixture");
  for (const extra of [{ userId: "fictional-other" }, { scope: "agent", agentId: "fictional-other" }, { scope: "task", taskId: "fictional-other" }, { sensitivity: "private" }, { userConfirmed: false }])
    await f.remember("supported forbidden fixture", extra);
  for (const actor of [denseActor, { ...denseActor, userId: "fictional-other" }, { ...denseActor, agentId: "fictional-other", taskId: "fictional-other" }])
    await f.service.synchronizeDenseIndex({ ...actor, includePrivate: true });
  expect((await f.service.recall(request)).memories.map(memory => memory.id)).toEqual([allowed.current.id]);
  expect((await f.service.context(request)).items.map(item => item.memoryId)).toEqual([allowed.current.id]);
  expect((await f.service.query(request)).contextPack.items.map(item => item.memoryId)).toEqual([allowed.current.id]);
  expect(inspected.join(" ")).not.toContain("forbidden");
});
it("discards all partial rescue evidence if reverse inference is unavailable", async () => {
  const f = setup(verifier(async premise => { if (premise === request.query) throw new Error("fictional failure"); return support; }));
  await f.remember("supported fixture"); await f.service.synchronizeDenseIndex(denseActor);
  const batch = await f.dense.retrieve(request, 0); expect(batch.hits).toEqual([]); expect(batch.dense?.reason).toBe("verification_unavailable");
  expect(batch.dense?.rescue).toBeUndefined(); expect(batch.dense?.reversePairs?.[0]?.reason).toBe("verification_unavailable");
});
it("uses one shared deadline for the complete rescue and preserves late model ownership", async () => {
  let release: (() => void) | undefined;
  const pending = new Promise<void>(resolve => { release = resolve; });
  const f = setup(verifier(async premise => { if (premise === request.query) await pending; return support; }), { modelTimeoutMs: 5 });
  await f.remember("supported fixture"); await f.service.synchronizeDenseIndex(denseActor);
  const batch = await f.dense.retrieve(request, 0); expect(batch.hits).toEqual([]); expect(batch.dense?.reason).toBe("unavailable");
  let closed = false; const closing = f.service.close().then(() => { closed = true; });
  await new Promise(resolve => setTimeout(resolve, 10)); expect(closed).toBe(false); release!(); await closing;
});
it("rejects forged direction and stale current versions during verification", async () => {
  const delegate = verifier(); let change: (() => Promise<void>) | undefined;
  const wrapper: DensePairVerifier = { directions: delegate.directions, policy: delegate.policy, fingerprint: () => delegate.fingerprint(), close: () => delegate.close(), verify: async input => {
    const receipt = await delegate.verify(input); await change?.(); return receipt;
  } };
  const f = setup(wrapper); await f.remember("supported old fixture"); await f.service.synchronizeDenseIndex(denseActor);
  change = async () => { change = undefined; await f.remember("supported new fixture", { key: "fictional-0" }); };
  expect((await f.dense.retrieve(request, 0)).dense?.reason).toBe("index_changed");
  await f.service.synchronizeDenseIndex(denseActor);
  wrapper.verify = async input => ({ ...await delegate.verify(input), direction: undefined });
  expect((await f.dense.retrieve(request, 0)).dense?.reason).toBe("unavailable");
});
it("rejects forged rescue receipts and binds strategy and width to pagination", async () => {
  const twin = setup(verifier(async (premise, hypothesis) => premise === request.query && hypothesis.includes("second") ? neutral : support));
  await twin.remember("supported first fixture"); await twin.remember("supported second fixture"); await twin.service.synchronizeDenseIndex(denseActor);
  const duplicate = await twin.dense.retrieve(request, 0); validateCandidateBatches([duplicate]);
  const reverse = duplicate.dense!.reversePairs!.find(pair => pair.accepted)!;
  duplicate.dense!.reversePairs = [reverse, structuredClone(reverse)];
  expect(() => validateCandidateBatches([duplicate])).toThrow(/Dense/);
  const f = setup(); await f.remember("literal decoy fixture"); await f.remember("literal supported fixture"); await f.service.synchronizeDenseIndex(denseActor);
  const batch = await f.dense.retrieve(request, 0); validateCandidateBatches([batch]); batch.dense!.rescue!.mutualSupportedMemoryIds = [];
  expect(() => validateCandidateBatches([batch])).toThrow();
  const page = await f.service.recall({ ...request, query: "literal", limit: 1 }); expect(page.nextCursor).toBeDefined();
  for (const extra of [{ candidateSelection: "score_gate" as const }, { maxVerificationCandidates: 2 }]) {
    const other = new DenseRetriever(f.index, f.provider, { admission: denseAdmission, mode: "hybrid", candidateSelection: "bidirectional_rescue", pairVerifier: verifier(), ...extra });
    try {
      const { MemoryService } = await import("../../../src/core/application/memory-service.js");
      const alternate = new MemoryService(f.store, { experimentalDense: other });
      await expect(alternate.recall({ ...request, query: "literal", limit: 1, cursor: page.nextCursor! })).rejects.toThrow(/cursor/i);
    } finally { await other.close(); }
  }
});
