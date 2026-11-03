import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { evaluateDense } from "../../../evals/dense/evaluator.js";
import { LocalDensePairVerifier } from "../../../src/core/retrieval/dense/local-pair-verifier.js";
import type { EmbeddingProvider } from "../../../src/core/retrieval/dense/index-contracts.js";
import { SqliteDenseIndex } from "../../../src/storage/sqlite/dense-index.js";
import { LocalCandidateReranker } from "../../../src/core/retrieval/reranking/local-reranker.js";
import { MemoryService } from "../../../src/core/application/memory-service.js";

describe("Dense quality inference availability", () => {
  const directories: string[] = [];
  afterEach(() => { for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true }); });
  function fixture(failAt?: number) {
    const directory = mkdtempSync(join(tmpdir(), "oc-fictional-dense-judgments-")); directories.push(directory);
    const file = join(directory, "synthetic.json");
    writeFileSync(file, JSON.stringify({ corpus: [{ id: "first", text: "fictional first assertion" }, { id: "second", text: "fictional second assertion" }],
      cases: [{ id: "negative", category: "negation", query: "unrelated question", relevant: [], forbidden: ["first", "second"] }] }));
    let queries = 0, closes = 0;
    const provider: EmbeddingProvider = { model: { fingerprint: "a".repeat(64), dimensions: 2, textVersion: "memory-value-v1" },
      load: async () => ({ model: provider.model, embed: async (texts, mode) => {
        if (mode === "query" && ++queries === failAt) throw new Error("fictional inference failure");
        return texts.map(text => mode === "query" ? [1, 0] : text.includes("first") ? [1, 0] : [0, 1]);
      }, close: async () => { closes++; } }) };
    return { file, provider, closes: () => closes };
  }
  it.each([["recall", 1], ["context", 4], ["query", 7]] as const)("does not score a failed %s inference as a correct negative", async (_endpoint, failAt) => {
    const f = fixture(failAt);
    await expect(evaluateDense(f.provider, f.file, "miss_only")).rejects.toThrow(/cannot count runtime fallback/);
    expect(f.closes()).toBe(1);
  });
  it("rejects unavailable pair inference while releasing both model owners", async () => {
    const f = fixture(); let verifierCloses = 0;
    const fingerprint = "b".repeat(64);
    await expect(evaluateDense(f.provider, f.file, "miss_only", async () => new LocalDensePairVerifier({ modelFingerprint: fingerprint,
      load: async () => ({ modelFingerprint: fingerprint, compare: async () => { throw new Error("fictional verifier failure"); },
        close: async () => { verifierCloses++; } }) }, { version: "dense-pair-v1", modelFingerprint: fingerprint, minEntailment: .5, maxContradiction: .5 })))
      .rejects.toThrow(/cannot count runtime fallback/);
    expect(f.closes()).toBe(1); expect(verifierCloses).toBe(1);
  });
  it("continues to score genuine model rejection separately from model availability", async () => {
    const f = fixture();
    const report = await evaluateDense(f.provider, f.file, "miss_only", async () => new LocalDensePairVerifier({ modelFingerprint: "b".repeat(64),
      load: async () => ({ modelFingerprint: "b".repeat(64), compare: async () => ({ contradiction: .9, neutral: .05, entailment: .05 }), close: async () => {} }) },
      { version: "dense-pair-v1", modelFingerprint: "b".repeat(64), minEntailment: .5, maxContradiction: .5 }));
    for (const row of report.rows) {
      expect(row.stable).toBe(true);
      expect(row.rounds.every(round => round.passed && round.selected.length === 0)).toBe(true);
    }
    expect(f.closes()).toBe(1);
  });
  it("keeps the disabled control arm independent of both model factories", async () => {
    const f = fixture(); let verifierFactories = 0;
    const report = await evaluateDense(f.provider, f.file, "off", async () => {
      verifierFactories++; throw new Error("disabled control must not load a verifier");
    });
    expect(verifierFactories).toBe(0); expect(f.closes()).toBe(0);
    expect(report.verifier).toBeNull(); expect(report.verifierPreparationMs).toBe(0);
  });
  it("releases a verifier whose warmup fails before service ownership exists", async () => {
    const f = fixture(); let closes = 0;
    await expect(evaluateDense(f.provider, f.file, "miss_only", async () => ({
      policy: { version: "dense-pair-v1", modelFingerprint: "b".repeat(64), minEntailment: .5, maxContradiction: .5 },
      fingerprint: () => ({ model: "b".repeat(64), policy: "c".repeat(64), runtime: "d".repeat(64) }),
      warmup: async () => { throw new Error("fictional warmup failure"); },
      verify: async () => { throw new Error("must not reach pair inference"); },
      close: async () => { closes++; },
    }))).rejects.toThrow("fictional warmup failure");
    expect(closes).toBe(1); expect(f.closes()).toBe(0);
  });
  it("releases a warmed verifier when incompatible identity blocks construction", async () => {
    const f = fixture(); let warmups = 0, closes = 0;
    await expect(evaluateDense(f.provider, f.file, "miss_only", async () => ({
      policy: { version: "dense-pair-v1", modelFingerprint: "b".repeat(64), minEntailment: .5, maxContradiction: .5 },
      fingerprint: () => ({ model: "invalid", policy: "c".repeat(64), runtime: "d".repeat(64) }),
      warmup: async () => { warmups++; },
      verify: async () => { throw new Error("must not reach pair inference"); },
      close: async () => { closes++; },
    }))).rejects.toThrow("Invalid verifier identity");
    expect(warmups).toBe(1); expect(closes).toBe(1); expect(f.closes()).toBe(0);
  });
  it("validates fictional judgments before allocating a verification model", async () => {
    const f = fixture(); let verifierFactories = 0;
    writeFileSync(f.file, JSON.stringify({ corpus: [], cases: [] }));
    await expect(evaluateDense(f.provider, f.file, "miss_only", async () => {
      verifierFactories++; throw new Error("invalid judgments must not allocate a model");
    })).rejects.toThrow();
    expect(verifierFactories).toBe(0); expect(f.closes()).toBe(0);
  });
  it.each([["recall", 1], ["context", 4], ["query", 7]] as const)("does not count unavailable reverse %s inference as a negative pass", async (_endpoint, failAt) => {
    const f = fixture(); let reverseCalls = 0, closes = 0;
    f.provider.load = async () => ({ model: f.provider.model, embed: async (texts, mode) => texts.map(() => mode === "query" ? [1, 0] : [.5, Math.sqrt(.75)]), close: async () => {} });
    const modelFingerprint = "b".repeat(64);
    await expect(evaluateDense(f.provider, f.file, "hybrid", async () => new LocalDensePairVerifier({ modelFingerprint,
      load: async () => ({ modelFingerprint, compare: async (premise, hypothesis) => {
        if (premise === "unrelated question" && ++reverseCalls === failAt) throw new Error("fictional reverse unavailable");
        return (premise.includes("first") || hypothesis.includes("first")) ? { entailment: .9, neutral: .05, contradiction: .05 } : { entailment: .05, neutral: .9, contradiction: .05 };
      }, close: async () => { closes++; } }) }, { version: "dense-pair-v1", modelFingerprint, minEntailment: .5, maxContradiction: .5 }, { cacheEntries: 0 }),
      undefined, "optimized", { candidateSelection: "bidirectional_rescue" })).rejects.toThrow(/cannot count runtime fallback/);
    expect(closes).toBe(1);
  });
  it("validates rescue evaluation options before opening either model", async () => {
    const f = fixture(); let factories = 0;
    const create = async () => { factories++; throw new Error("invalid policy must not allocate"); };
    await expect(evaluateDense(f.provider, f.file, "off", create, undefined, "optimized", { candidateSelection: "bidirectional_rescue" })).rejects.toThrow(/selection/);
    await expect(evaluateDense(f.provider, f.file, "hybrid", create, undefined, "optimized", { maxVerificationCandidates: 0 })).rejects.toThrow(/budget/);
    expect(factories).toBe(0); expect(f.closes()).toBe(0);
  });
  it("does not count an index generation change as a scored rejection", async () => {
    const f = fixture(); let revision = 0;
    const spy = vi.spyOn(SqliteDenseIndex.prototype, "revision").mockImplementation(() => `fictional-changing-index-${revision++}`);
    try { await expect(evaluateDense(f.provider, f.file, "hybrid")).rejects.toThrow(/cannot count runtime fallback/); }
    finally { spy.mockRestore(); }
  });
  it("does not allocate either optional model for a disabled control arm", async () => {
    const f = fixture(); let factories = 0;
    const report = await evaluateDense(f.provider, f.file, "off", undefined, undefined, "optimized", { createReranker: async () => { factories++; throw new Error("must stay disabled"); } });
    expect(factories).toBe(0); expect(report.reranker).toBeNull(); expect(report.rerankerPreparationMs).toBe(0);
  });
  it("does not count unavailable reranking as a successful baseline fallback", async () => {
    const f = fixture(); const model = "b".repeat(64);
    const createVerifier = async () => new LocalDensePairVerifier({ modelFingerprint: model, load: async () => ({ modelFingerprint: model,
      compare: async () => ({ entailment: .9, neutral: .05, contradiction: .05 }), close: async () => {} }) },
      { version: "dense-pair-v1", modelFingerprint: model, minEntailment: .5, maxContradiction: .5 });
    await expect(evaluateDense(f.provider, f.file, "hybrid", createVerifier, undefined, "optimized", { candidateSelection: "bidirectional_rescue",
      createReranker: async () => new LocalCandidateReranker({ modelFingerprint: model, load: async () => ({ modelFingerprint: model,
        score: async () => { throw new Error("fictional missing inference"); }, close: async () => {} }) }) })).rejects.toThrow(/cannot count runtime fallback/);
  });
  it("drains bounded index batches for larger fictional populations", async () => {
    const f = fixture(); const corpus = Array.from({ length: 205 }, (_, i) => ({ id: `fictional-${i}`, text: `fictional assertion ${i}` }));
    writeFileSync(f.file, JSON.stringify({ corpus, cases: [{ id: "fictional-large", category: "absence", query: "not present", relevant: [], forbidden: corpus.map(row => row.id) }] }));
    const report = await evaluateDense(f.provider, f.file, "hybrid"); expect(report.indexing[0]).toMatchObject({ attempted: 205, indexed: 205, batches: 3, remaining: 0 });
  });
  it("rejects a stalled indexing loop instead of scoring a missing index", async () => {
    const f = fixture(); const spy = vi.spyOn(MemoryService.prototype, "synchronizeDenseIndex").mockResolvedValue({ attempted: 0, indexed: 0, stale: 0, failed: 0, remaining: 1 });
    try { await expect(evaluateDense(f.provider, f.file, "hybrid")).rejects.toThrow(/stalled indexing/); }
    finally { spy.mockRestore(); }
  });
  it("releases both optional models if relevance warmup fails", async () => {
    const f = fixture(); let closed = 0;
    const model = "b".repeat(64);
    await expect(evaluateDense(f.provider, f.file, "hybrid", async () => new LocalDensePairVerifier({ modelFingerprint: model,
      load: async () => ({ modelFingerprint: model, compare: async () => ({ entailment: .9, neutral: .05, contradiction: .05 }), close: async () => { closed++; } }) },
      { version: "dense-pair-v1", modelFingerprint: model, minEntailment: .5, maxContradiction: .5 }), undefined, "optimized", { candidateSelection: "bidirectional_rescue",
      createReranker: async () => ({ fingerprint: () => ({ model, policy: model, runtime: model }), warmup: async () => { throw new Error("fictional relevance warmup failure"); },
        rank: async () => { throw new Error("must not score"); }, close: async () => { closed++; } }) })).rejects.toThrow(/warmup failure/);
    expect(closed).toBe(2); expect(f.closes()).toBe(0);
  });
});
