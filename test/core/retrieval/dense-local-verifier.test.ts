import { createHash } from "node:crypto";
import { afterEach, expect, it } from "vitest";
import { LocalDensePairVerifier } from "../../../src/core/retrieval/dense/local-pair-verifier.js";
import { validateBoundVerification } from "../../../src/core/retrieval/dense/validate-verification.js";
import type { BoundDensePairRequest, DensePairSession } from "../../../src/core/retrieval/dense/verification/contracts.js";
import { denseActor, denseFixture } from "../../helpers/dense-fixture.js";

const model = "c".repeat(64), hash = (value: string) => createHash("sha256").update(value).digest("hex");
function request(extra: Partial<BoundDensePairRequest> = {}): BoundDensePairRequest { return { memoryId: "fictional-memory", sourceEventId: "fictional-event", memoryVersion: 1,
  accessFingerprint: "a".repeat(64), memoryText: "fictional approved value", query: "fictional query", contentFingerprint: hash("fictional approved value"), queryFingerprint: hash("fictional query"), ...extra }; }
const verifiers: LocalDensePairVerifier[] = [], fixtures: ReturnType<typeof denseFixture>[] = [];
afterEach(async () => { for (const f of fixtures.splice(0)) await f.cleanup(); for (const v of verifiers.splice(0)) await v.close(); });
function setup(compare?: DensePairSession["compare"], runtime: ConstructorParameters<typeof LocalDensePairVerifier>[2] = {}) {
  const calls = { load: 0, run: 0, close: 0 };
  const value = new LocalDensePairVerifier({ modelFingerprint: model, load: async () => { calls.load++; return { modelFingerprint: model,
    compare: async (premise, query) => { calls.run++; return compare ? compare(premise, query) : { entailment: .9, neutral: .05, contradiction: .05 }; }, close: async () => { calls.close++; } }; } },
    { version: "dense-pair-v1", modelFingerprint: model, minEntailment: .5, maxContradiction: .5 }, runtime);
  verifiers.push(value); return { value, calls };
}
it("binds a model verdict to content, query, event, version and access scope", async () => {
  const { value, calls } = setup(); const first = await value.verify(request()); expect(first).toMatchObject({ accepted: true, cache: "miss", memoryVersion: 1 });
  validateBoundVerification(request(), first, value); expect((await value.verify(request())).cache).toBe("hit"); expect(calls.run).toBe(1);
  for (const extra of [{ memoryVersion: 2 }, { sourceEventId: "next-event" }, { accessFingerprint: "b".repeat(64) }]) await value.verify(request(extra));
  expect(calls.run).toBe(4);
  expect(() => validateBoundVerification(request(), { ...first, memoryVersion: 2 }, value)).toThrow(/Unbound/);
  expect(() => validateBoundVerification(request(), { ...first, accepted: false }, value)).toThrow(/Unbound/);
});
it("rejects caller fingerprints that do not describe the actual text", async () => {
  const { value, calls } = setup(); await expect(value.verify(request({ query: "changed query" }))).rejects.toThrow(/Unbound/); expect(calls.load).toBe(0);
});
it("caches model rejection as rejection and never treats it as approval", async () => {
  const { value, calls } = setup(async () => ({ entailment: .05, neutral: .05, contradiction: .9 }));
  expect(await value.verify(request())).toMatchObject({ accepted: false, reason: "contradictory_pair" });
  expect(await value.verify(request())).toMatchObject({ accepted: false, cache: "hit" }); expect(calls.run).toBe(1);
});
it("rejects malformed probability evidence without caching it", async () => {
  const { value } = setup(async () => ({ entailment: .9, neutral: .9, contradiction: .9 }));
  await expect(value.verify(request())).rejects.toThrow(); expect(value.status().cacheEntries).toBe(0);
});
it("retains model capacity on timeout and close drains the actual computation", async () => {
  let release: (() => void) | undefined; const pending = new Promise<void>(resolve => { release = resolve; });
  const { value, calls } = setup(async () => { await pending; return { entailment: .9, neutral: .05, contradiction: .05 }; }, { timeoutMs: 5, maxPending: 1 });
  expect(await value.verify(request())).toMatchObject({ accepted: false, reason: "verification_unavailable" });
  expect(value.status().pending).toBe(1); expect(await value.verify(request())).toMatchObject({ accepted: false, reason: "verification_unavailable" }); expect(calls.run).toBe(1);
  let closed = false; const closing = value.close().then(() => { closed = true; }); await new Promise(resolve => setTimeout(resolve, 10)); expect(closed).toBe(false);
  release!(); await closing; expect(calls.close).toBe(1); expect(value.status().cacheEntries).toBe(0);
});
it("expires and bounds verdict caches without storing prompt or memory text", async () => {
  const { value, calls } = setup(undefined, { cacheEntries: 1, cacheTtlMs: 10 });
  await value.verify(request()); await value.verify(request({ memoryVersion: 2 })); expect(value.status().cacheEntries).toBe(1);
  await value.verify(request()); expect(calls.run).toBe(3); await new Promise(resolve => setTimeout(resolve, 15)); expect(value.status().cacheEntries).toBe(0);
});
it("keeps existing lexical results when a typed model veto rejects Dense additions", async () => {
  const { value } = setup(async () => ({ entailment: .05, neutral: .05, contradiction: .9 }));
  const f = denseFixture({ mode: "hybrid", pairVerifier: value }); fixtures.push(f);
  await f.remember("literal answer"); await f.remember("unrelated"); await f.service.synchronizeDenseIndex(denseActor);
  const result = await f.service.recall({ ...denseActor, query: "literal" }); expect(result.memories).toHaveLength(1);
  expect(result.memories[0]?.retrieval?.channels).toEqual(["full_text"]);
  expect(result.retrieval?.channelResults?.at(-1)?.dense?.pairs?.[0]).toMatchObject({ accepted: false, reason: "contradictory_pair", memoryVersion: 1 });
});
it("returns bounded typed model receipts through Recall and counts unverified hybrid candidates", async () => {
  const { value } = setup(); const f = denseFixture({ mode: "hybrid", pairVerifier: value, maxVerificationCandidates: 1 }); fixtures.push(f);
  await f.remember("current"); await f.remember("second"); await f.service.synchronizeDenseIndex(denseActor);
  const result = await f.service.recall({ ...denseActor, query: "fictional semantic question" }); expect(result.memories).toHaveLength(1);
  expect(result.retrieval?.channelResults?.at(-1)?.dense).toMatchObject({ verificationBudget: { attempted: 1, notVerified: 1, limit: 1 }, pairs: [{ accepted: true }] });
  expect(result.retrieval?.truncated).toBe(true);
  const query = await f.service.query({ ...denseActor, query: "fictional semantic question" });
  expect(query.evidence[0]?.memory.retrieval?.evidence?.[0]?.verification).toMatchObject({ accepted: true, memoryVersion: 1, modelFingerprint: model });
});
