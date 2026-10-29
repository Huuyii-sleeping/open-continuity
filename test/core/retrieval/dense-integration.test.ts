import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { MemoryService } from "../../../src/core/application/memory-service.js";
import { DenseRetriever } from "../../../src/core/retrieval/dense/retriever.js";
import { validateCandidateBatches } from "../../../src/core/retrieval/validation.js";
import { capabilitiesWithServiceSupport } from "../../../src/core/application/capabilities.js";
import { developmentCapabilities } from "../../../src/core/runtime/profile.js";
import { denseActor, denseFixture, denseModel, denseAdmission } from "../../helpers/dense-fixture.js";

describe("explicit Dense Core integration", () => {
  const fixtures: ReturnType<typeof denseFixture>[] = [];
  afterEach(async () => { for (const f of fixtures.splice(0)) await f.cleanup(); });
  function setup(...args: Parameters<typeof denseFixture>) { const f = denseFixture(...args); fixtures.push(f); return f; }
  const request = { ...denseActor, query: "fictional semantic question" };
  it("returns actual cosine evidence through recall, Context and Query with version citations", async () => {
    const f = setup(), memory = await f.remember("approved current fact"); await f.remember("unrelated distractor");
    expect(await f.service.synchronizeDenseIndex(denseActor)).toMatchObject({ indexed: 2, failed: 0 });
    const recalled = await f.service.recall(request);
    expect(recalled.memories[0]).toMatchObject({ id: memory.current.id, sourceEventId: memory.event.id, retrieval: {
      channels: ["dense"], ranks: { dense: 1 }, evidence: [{ rankMeaning: "relevance", score: { model: "cosine_similarity", value: 1 } }] } });
    expect(recalled.retrieval?.channelResults?.at(-1)?.dense).toMatchObject({ mode: "miss_only", reason: "admitted" });
    const context = await f.service.context(request);
    expect(context.items[0]?.reasons).toContain("retrieval_dense");
    expect(context.items[0]?.memoryId).toBe(memory.current.id);
    const query = await f.service.query(request);
    expect(query.evidence.some(item => item.memory.id === memory.current.id)).toBe(true);
    expect(query.answer?.citations.some(item => item.sourceEventId === memory.event.id && item.version === 1)).toBe(true);
  });
  it("does not load/query the model for a preserved lexical hit", async () => {
    const f = setup(); await f.remember("keyword literal answer"); await f.remember("unrelated");
    const result = await f.service.recall({ ...denseActor, query: "keyword" });
    expect(result.memories).toHaveLength(1); expect(f.calls).toMatchObject({ load: 0, run: 0 });
    expect(result.retrieval?.channelResults?.at(-1)?.dense?.reason).toBe("lexical_preserved");
  });
  it("uses Dense as an independent rank in the explicitly requested hybrid experiment", async () => {
    const f = setup({ mode: "hybrid" }, async (texts, mode) => texts.map(text => mode === "query" ? [1, 0] : text.includes("first") ? [1, 0] : [.8, .6]));
    await f.remember("literal first fact"); await f.remember("literal second fact"); await f.service.synchronizeDenseIndex(denseActor);
    const result = await f.service.recall({ ...denseActor, query: "literal" });
    expect(result.memories[0]?.retrieval?.scoreModel).toBe("rrf");
    expect(result.memories[0]?.retrieval?.channels).toEqual(["full_text", "dense"]);
    expect(result.memories[0]?.retrieval?.evidence?.map(item => item.score.model)).toEqual(["fts5_bm25", "cosine_similarity"]);
    expect(result.memories[0]?.value).toBe("literal first fact");
  });
  it("binds model, policy, enabled mode and index generation to cursors", async () => {
    const f = setup({ mode: "hybrid" }); await f.remember("first"); await f.remember("second"); await f.service.synchronizeDenseIndex(denseActor);
    const page = await f.service.recall({ ...request, limit: 1 }); expect(page.nextCursor).toBeDefined();
    const next = await f.service.recall({ ...request, limit: 1, cursor: page.nextCursor ?? undefined }); expect(next.memories).toHaveLength(1);
    expect(next.memories[0]?.id).not.toBe(page.memories[0]?.id);
    const plain = new MemoryService(f.store);
    await expect(plain.recall({ ...request, cursor: page.nextCursor ?? undefined })).rejects.toThrow(/cursor/i);
    await f.remember("new current");
    await expect(f.service.recall({ ...request, cursor: page.nextCursor ?? undefined })).rejects.toThrow(/cursor/i);
  });
  it.each(["single", "ambiguous", "missing"])("abstains with an explicit reason for %s coverage", async scenario => {
    const f = setup(); await f.remember("first"); if (scenario !== "single") await f.remember("second");
    if (scenario !== "missing") await f.service.synchronizeDenseIndex(denseActor);
    const result = await f.service.recall(request); expect(result.memories).toHaveLength(0);
    expect(result.retrieval?.channelResults?.at(-1)?.dense?.reason).toBe(scenario === "single" ? "insufficient_comparison" : scenario === "ambiguous" ? "ambiguous_candidates" : "index_incomplete");
  });
  it("keeps lexical answers when the model fails or returns invalid vectors", async () => {
    let broken = false;
    const f = setup({ mode: "hybrid" }, async texts => texts.map(() => broken ? [NaN, 0] : [1, 0]));
    await f.remember("literal answer"); await f.service.synchronizeDenseIndex(denseActor); broken = true;
    const result = await f.service.recall({ ...denseActor, query: "literal" }); expect(result.memories).toHaveLength(1);
    expect(result.retrieval?.channelResults?.at(-1)?.dense?.reason).toBe("unavailable");
  });
  it("fails open on index corruption and rejects a stale model handle", async () => {
    const f = setup({ mode: "hybrid" }); await f.remember("literal answer"); await f.service.synchronizeDenseIndex(denseActor);
    const db = new DatabaseSync(f.path); db.exec("UPDATE memory_dense_vectors SET vector=x'0000'"); db.close();
    expect((await f.service.recall({ ...denseActor, query: "literal" })).memories).toHaveLength(1);
    f.store.enableDenseIndex({ ...denseModel, fingerprint: "b".repeat(64) }, { reset: true });
    expect((await f.service.recall({ ...denseActor, query: "literal" })).memories).toHaveLength(1);
  });
  it("does not read or commit stale data after a deadline, and close drains underlying model work", async () => {
    let slow = false, settle: (() => void) | undefined;
    const f = setup({ mode: "hybrid", modelTimeoutMs: 10 }, async (texts, mode) => { if (slow && mode === "query") await new Promise<void>(resolve => { settle = resolve; }); return texts.map(() => [1, 0]); });
    await f.remember("literal answer"); await f.service.synchronizeDenseIndex(denseActor); slow = true;
    const result = await f.service.recall({ ...denseActor, query: "literal" }); expect(result.memories).toHaveLength(1);
    expect(f.dense.status().pending).toBe(1);
    let closed = false; const closing = f.service.close().then(() => { closed = true; });
    await new Promise(resolve => setTimeout(resolve, 20)); expect(closed).toBe(false); expect(f.calls.close).toBe(0);
    settle!(); await closing; expect(f.calls.close).toBe(1);
  });
  it("rejects evidence changed by a writer while model scoring is in flight", async () => {
    let mutate: (() => Promise<void>) | undefined;
    const f = setup({ mode: "hybrid" }, async (texts, mode) => { if (mode === "query") await mutate?.(); return texts.map(() => [1, 0]); });
    await f.remember("literal old"); await f.service.synchronizeDenseIndex(denseActor);
    mutate = async () => { await f.remember("literal new", { key: "fictional-0" }); };
    const result = await f.service.recall({ ...denseActor, query: "literal" });
    expect(result.retrieval?.channelResults?.at(-1)?.dense?.reason).toBe("index_changed");
    expect(result.memories[0]?.retrieval?.channels).toEqual(["full_text"]);
  });
  it("keeps an optional verifier as a veto, with no automatic authority upgrade", async () => {
    const f = setup({ verify: async () => false, verificationFingerprint: "c".repeat(64) });
    await f.remember("current"); await f.remember("unrelated"); await f.service.synchronizeDenseIndex(denseActor);
    const result = await f.service.recall(request); expect(result.memories).toHaveLength(0);
    expect(result.retrieval?.channelResults?.at(-1)?.dense).toMatchObject({ reason: "pair_rejected", verification: "pair_model" });
  });
  it("reports the active experimental capability while the default remains lexical", () => {
    const f = setup();
    expect(capabilitiesWithServiceSupport(developmentCapabilities(), f.service).retrieval.semantic).toBe(true);
    expect(developmentCapabilities().retrieval.semantic).toBe(false);
    expect(f.service.retrievalCapabilityPolicy().experimentalDense).toMatchObject({ status: "experimental", mode: "miss_only" });
    expect(new MemoryService(f.store).retrievalCapabilityPolicy().experimentalDense).toBeNull();
    const enabled = capabilitiesWithServiceSupport(developmentCapabilities(), f.service);
    expect(capabilitiesWithServiceSupport(enabled, new MemoryService(f.store)).retrieval.experimentalDense).toBeUndefined();
  });
  it("never exposes other users/scopes/private/unapproved vectors through any consumer", async () => {
    const f = setup();
    await f.remember("unrelated authorized distractor");
    const forbidden = [await f.remember("matching other user", { userId: "fictional-other" }),
      await f.remember("matching other agent", { scope: "agent", agentId: "fictional-other" }),
      await f.remember("matching other task", { scope: "task", taskId: "fictional-other" }),
      await f.remember("matching private", { sensitivity: "private" }), await f.remember("matching unapproved", { userConfirmed: false })];
    for (const actor of [denseActor, { ...denseActor, userId: "fictional-other" }, { ...denseActor, agentId: "fictional-other", taskId: "fictional-other" }])
      await f.service.synchronizeDenseIndex({ ...actor, includePrivate: true });
    const ids = forbidden.map(item => item.current.id);
    expect((await f.service.recall(request)).memories.some(item => ids.includes(item.id))).toBe(false);
    expect((await f.service.context(request)).items.some(item => ids.includes(item.memoryId))).toBe(false);
    expect((await f.service.query(request)).contextPack.items.some(item => ids.includes(item.memoryId))).toBe(false);
  });
  it("keeps model slots occupied after four timeouts and refuses a fifth request", async () => {
    let slow = false, release: (() => void) | undefined;
    const wait = new Promise<void>(resolve => { release = resolve; });
    const f = setup({ mode: "hybrid", modelTimeoutMs: 5 }, async texts => { if (slow) await wait; return texts.map(() => [1, 0]); });
    await f.remember("current"); await f.service.synchronizeDenseIndex(denseActor); slow = true;
    for (let index = 0; index < 5; index++) expect((await f.dense.retrieve(request, 0)).status).toBe("skipped");
    expect(f.dense.status().pending).toBe(4); expect(f.calls.run).toBe(5);
    release!(); await f.service.close();
  });
  it("rejects a loaded session from a different model without evaluating it", async () => {
    const f = setup(); await f.remember("current");
    let evaluated = false, released = false;
    const dense = new DenseRetriever(f.index, { model: denseModel, load: async () => ({ model: { ...denseModel, fingerprint: "b".repeat(64) },
      embed: async () => { evaluated = true; return [[1, 0]]; }, close: async () => { released = true; } }) }, { admission: denseAdmission });
    expect((await dense.synchronize(request)).failed).toBe(1); expect(evaluated).toBe(false);
    await dense.close(); expect(released).toBe(true);
  });
  it("rejects incompatible models and forged Dense score evidence", async () => {
    const f = setup();
    expect(() => new DenseRetriever(f.index, { model: { ...denseModel, fingerprint: "b".repeat(64) }, load: async () => { throw new Error(); } }, { admission: denseAdmission })).toThrow(/incompatible/);
    await f.remember("current"); await f.remember("unrelated"); await f.service.synchronizeDenseIndex(denseActor);
    const batch = await f.dense.retrieve(request, 0); validateCandidateBatches([batch]);
    batch.hits[0]!.score = { model: "none", value: null, direction: "not_applicable" };
    expect(() => validateCandidateBatches([batch])).toThrow(/Dense/);
  });
});
