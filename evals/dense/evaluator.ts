import { readFileSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { createHash } from "node:crypto";
import { performance } from "node:perf_hooks";
import { isDeepStrictEqual } from "node:util";
import { z } from "zod";
import { MemoryService } from "../../src/core/application/memory-service.js";
import { SqliteMemoryStore } from "../../src/storage/sqlite/sqlite-memory-store.js";
import { DenseRetriever } from "../../src/core/retrieval/dense/retriever.js";
import type { DensePairVerifier } from "../../src/core/retrieval/dense/verification/contracts.js";
import type { EmbeddingProvider } from "../../src/core/retrieval/dense/index-contracts.js";
import type { DenseRetrievalExtension } from "../../src/core/retrieval/contracts.js";
import type { CandidateReranker } from "../../src/core/retrieval/reranking/contracts.js";
import type { MemoryEvent, RecallResult, RememberInput, ResolvedMemory } from "../../src/shared/types.js";
import { latencySummary, mean, ratio, scoreRanking } from "../baseline/metrics.js";

const corpusSchema = z.object({ corpus: z.array(z.object({ id: z.string().min(1), text: z.string().min(1) })).min(2),
  cases: z.array(z.object({ id: z.string().min(1), category: z.string(), query: z.string().min(1), relevant: z.array(z.string()), forbidden: z.array(z.string()) })).min(1) });
interface EvaluationCase { id: string; category: string; status: string; query: string; limit?: number;
  writes: Array<RememberInput & { label: string }>; expected: { relevant: string[]; forbidden: string[]; ordered?: string[]; values?: Array<{ label: string; value: unknown; version?: number }> }; }
interface DenseEvaluationRound { round: number; selected: string[]; passed: boolean; elapsedMs: number; valueMatches: boolean;
  scores: ReturnType<typeof scoreRanking>; channelResults?: NonNullable<RecallResult["retrieval"]>["channelResults"]; }
interface DenseEvaluationRow { id: string; category: string; status: string; endpoint: "recall" | "context" | "query";
  positive: boolean; stable: boolean; rounds: DenseEvaluationRound[]; }
function casesFor(file: string): EvaluationCase[] {
  const data: unknown = JSON.parse(readFileSync(file, "utf8"));
  if (file.endsWith("quality-v1.json")) {
    const source = data as { retrieval: Array<{ id: string; category: string; status: string; query: string; limit?: number;
      memories?: Array<{ label: string; key: string; value: unknown; sensitivity?: "public" | "private"; userConfirmed?: boolean }>;
      writes?: Array<{ label: string; key: string; value: unknown; idempotencyKey: string; expectedVersion?: number; writeMode?: "merge" | "replace" }>;
      expected: EvaluationCase["expected"] }> };
    if (!Array.isArray(source.retrieval) || !source.retrieval.length) throw new Error("Missing quality cases");
    return source.retrieval.map(item => ({ ...item, writes: [...item.memories ?? [], ...item.writes ?? []].map((write, index) => ({ ...write,
      userId: `fictional-dense-${item.id}`, agentId: "quality-seeder", kind: "user_preference", scope: "user", sensitivity: "sensitivity" in write ? write.sensitivity ?? "public" : "public",
      userConfirmed: "userConfirmed" in write ? write.userConfirmed ?? true : true, idempotencyKey: `fictional:${item.id}:${index}` })) }));
  }
  const source = corpusSchema.parse(data), labels = new Set(source.corpus.map(item => item.id));
  if (labels.size !== source.corpus.length || new Set(source.cases.map(item => item.id)).size !== source.cases.length
    || source.cases.some(item => [...item.relevant, ...item.forbidden].some(label => !labels.has(label)))) throw new Error("Invalid corpus judgments");
  return source.cases.map(item => ({ ...item, status: "challenge", expected: item, writes: source.corpus.map((memory, index) => ({
    label: memory.id, userId: `fictional-dense-${item.id}`, agentId: "quality-seeder", key: memory.id, value: memory.text, kind: "user_preference",
    scope: "user", sensitivity: "public", userConfirmed: true, idempotencyKey: `fictional:${item.id}:${index}` })) }));
}
export interface DenseEvaluationSeed { cases: Array<{ item: EvaluationCase; current: Array<[string, { label: string; memory: ResolvedMemory }]> }>; events: MemoryEvent[]; fingerprint: string; }
export async function seedDenseEvaluation(file: string): Promise<DenseEvaluationSeed> {
  const root = mkdtempSync(join(tmpdir(), "oc-fictional-dense-seed-")), store = new SqliteMemoryStore(join(root, "test.db")), service = new MemoryService(store);
  try {
    const cases = [];
    for (const item of casesFor(file)) {
      const current = new Map<string, { label: string; memory: ResolvedMemory }>();
      for (const { label, ...write } of item.writes) { const result = await service.remember(write); current.set(result.current.id, { label, memory: result.current }); }
      cases.push({ item, current: [...current.entries()] });
    }
    const events = store.exportEvents();
    return { cases, events, fingerprint: createHash("sha256").update(JSON.stringify(events)).digest("hex") };
  } finally { await service.close(); rmSync(root, { recursive: true, force: true }); }
}
export interface DenseEvaluationOptions { candidateSelection?: "score_gate" | "bidirectional_rescue"; maxVerificationCandidates?: number;
  createReranker?: () => Promise<CandidateReranker & { warmup(): Promise<void> }>; rerankingCandidateLimit?: number; }
export async function evaluateDense(provider: EmbeddingProvider, file: string, mode: "off" | "miss_only" | "hybrid", createVerifier?: () => Promise<DensePairVerifier & { warmup(): Promise<void> }>, seed?: DenseEvaluationSeed, ranking: "optimized" | "legacy" = "optimized", options: DenseEvaluationOptions = {}) {
  const candidateSelection = options.candidateSelection ?? "score_gate";
  if (!["score_gate", "bidirectional_rescue"].includes(candidateSelection) || (candidateSelection === "bidirectional_rescue" && (mode !== "hybrid" || !createVerifier))
    || (options.maxVerificationCandidates !== undefined && (!Number.isInteger(options.maxVerificationCandidates) || options.maxVerificationCandidates < 1 || options.maxVerificationCandidates > 4))
    || (options.createReranker !== undefined && typeof options.createReranker !== "function")
    || (mode !== "off" && options.createReranker && candidateSelection !== "bidirectional_rescue")
    || (options.rerankingCandidateLimit !== undefined && (!options.createReranker || !Number.isInteger(options.rerankingCandidateLimit) || options.rerankingCandidateLimit < 1 || options.rerankingCandidateLimit > 20)))
    throw new Error("Invalid Dense evaluation selection or verification budget");
  const fixture = seed ?? await seedDenseEvaluation(file);
  const root = mkdtempSync(join(tmpdir(), "oc-fictional-dense-eval-"));
  let store: SqliteMemoryStore | undefined;
  let pairVerifier: (DensePairVerifier & { warmup(): Promise<void> }) | undefined;
  let reranker: (CandidateReranker & { warmup(): Promise<void> }) | undefined;
  let dense: DenseRetriever | undefined;
  let service: MemoryService | undefined;
  try {
    store = new SqliteMemoryStore(join(root, "test.db"));
    store.importEvents(fixture.events);
    const nativeIndex = mode === "off" ? undefined : store.enableDenseIndex(provider.model);
    const index = nativeIndex && ranking === "legacy" ? { model: nativeIndex.model, revision: () => nativeIndex.revision(),
      pending: nativeIndex.pending.bind(nativeIndex), commit: nativeIndex.commit.bind(nativeIndex), coverage: nativeIndex.coverage.bind(nativeIndex),
      scan: nativeIndex.scan.bind(nativeIndex), population: nativeIndex.population.bind(nativeIndex) } : nativeIndex;
    const preparationStarted = performance.now();
    pairVerifier = mode !== "off" && createVerifier ? await createVerifier() : undefined;
    if (pairVerifier) await pairVerifier.warmup();
    const verifierPreparationMs = pairVerifier ? performance.now() - preparationStarted : 0;
    const rerankerPreparationStarted = performance.now();
    reranker = mode !== "off" && options.createReranker ? await options.createReranker() : undefined;
    if (reranker) await reranker.warmup();
    const rerankerPreparationMs = reranker ? performance.now() - rerankerPreparationStarted : 0;
    dense = mode === "off" ? undefined : new DenseRetriever(index!, provider, {
      mode, candidateSelection, ...(options.maxVerificationCandidates === undefined ? {} : { maxVerificationCandidates: options.maxVerificationCandidates }),
      ...(reranker ? { reranking: { reranker, candidateLimit: options.rerankingCandidateLimit ?? 20 } } : {}), ...(pairVerifier ? { pairVerifier } : {}),
      admission: { version: "dense-admission-v1", modelFingerprint: provider.model.fingerprint, minScore: .62, minMargin: .14, minimumCandidates: 2 } });
    // Observe every retrieval before Query packs its evidence and drops channel-level receipts.
    // Runtime fail-open is correct for clients, but unavailable inference is not a scored rejection.
    const activeDense = dense;
    const measuredDense: DenseRetrievalExtension | undefined = activeDense && {
      mode: activeDense.mode, fingerprint: () => activeDense.fingerprint(),
      synchronize: activeDense.synchronize.bind(activeDense), close: () => activeDense.close(),
      retrieve: async (...args) => {
        const batch = await activeDense.retrieve(...args);
        if (batch.skippedReason === "dense_unavailable" || batch.skippedReason === "dense_index_incomplete" || batch.dense?.reason === "index_changed"
          || batch.dense?.reason === "verification_unavailable" || batch.dense?.reason === "reranking_unavailable"
          || batch.dense?.pairs?.some(pair => pair.reason === "verification_unavailable")
          || batch.dense?.reversePairs?.some(pair => pair.reason === "verification_unavailable")) {
          throw new Error("Dense inference or index unavailable during quality evaluation; cannot count runtime fallback as a correct rejection");
        }
        return batch;
      },
    };
    service = new MemoryService(store, { ...(measuredDense ? { experimentalDense: measuredDense } : {}) }, { defaultTokenBudget: 4096, maxTokenBudget: 16384, maxMemories: 20, requireUserConfirmed: true });
    const rows: DenseEvaluationRow[] = [], indexing = [];
    for (const { item, current: entries } of fixture.cases) {
      const current = new Map(entries);
      const input = { userId: item.writes[0]!.userId, agentId: "quality-reader", query: item.query, includePrivate: false, limit: item.limit ?? 8 };
      if (dense) {
        const totals = { attempted: 0, indexed: 0, stale: 0, failed: 0, remaining: 0, batches: 0 };
        do {
          const indexed = await service.synchronizeDenseIndex(input); totals.batches++;
          totals.attempted += indexed.attempted; totals.indexed += indexed.indexed; totals.stale += indexed.stale; totals.failed += indexed.failed; totals.remaining = indexed.remaining;
          if (indexed.failed || (indexed.remaining && indexed.indexed === 0) || totals.attempted > 10000)
            throw new Error("Dense evaluation requires a complete, successfully computed index; unavailable model or stalled indexing is not a quality result");
        } while (totals.remaining);
        indexing.push({ id: item.id, ...totals });
      }
      for (const endpoint of ["recall", "context", "query"] as const) {
        const rounds: DenseEvaluationRound[] = [];
        for (let round = 1; round <= 3; round++) {
          const started = performance.now();
          const result = endpoint === "recall" ? await service.recall(input) : endpoint === "context"
            ? await service.context({ ...input, purpose: "general", tokenBudget: 4096, maxMemories: item.limit ?? 8 })
            : await service.query({ ...input, tokenBudget: 4096, maxMemories: item.limit ?? 8 });
          if ("execution" in result && result.execution.stoppedReason === "timeout")
            throw new Error("Query deadline expired during quality evaluation; unavailable execution is not a quality result");
          const elapsedMs = performance.now() - started;
          const memories = "memories" in result ? result.memories : "items" in result ? result.items : result.contextPack.items;
          const selected = memories.map(memory => current.get("id" in memory ? memory.id : memory.memoryId)?.label ?? "unknown");
          const valueMatches = (item.expected.values ?? []).every(expected => { const memory = memories.find(memory => current.get("id" in memory ? memory.id : memory.memoryId)?.label === expected.label);
            return memory && isDeepStrictEqual(memory.value, expected.value) && (expected.version === undefined || memory.version === expected.version); });
          const scores = scoreRanking(selected, item.expected, [1, 5]);
          const passed = scores.miss.numerator === 0 && scores.falseSelection.numerator === 0 && !scores.forbiddenSelected.length && valueMatches
            && (!item.expected.ordered || isDeepStrictEqual(selected.slice(0, item.expected.ordered.length), item.expected.ordered));
          const retrieval = "contextPack" in result ? result.contextPack.retrieval : result.retrieval;
          if (retrieval?.channelResults?.some(batch => batch.channel === "dense" && (batch.dense?.reason === "index_changed" || batch.skippedReason === "dense_unavailable")))
            throw new Error("Dense evidence invalidated after retrieval; cannot count fallback as a correct rejection");
          if (pairVerifier && retrieval?.channelResults?.some(batch => batch.dense?.pairs?.some(pair => pair.reason === "verification_unavailable")))
            throw new Error("Verifier unavailable during warm quality evaluation; cannot count missing inference as a correct rejection");
          rounds.push({ round, selected, passed, elapsedMs, valueMatches, scores, channelResults: retrieval?.channelResults });
        }
        rows.push({ id: item.id, category: item.category, status: item.status, endpoint, positive: item.expected.relevant.length > 0,
          stable: rounds.every(round => isDeepStrictEqual(round.selected, rounds[0]!.selected)), rounds });
      }
    }
    const summary = Object.fromEntries(["recall", "context", "query"].map(endpoint => {
      const group = rows.filter(row => row.endpoint === endpoint), first = group.map(row => row.rounds[0]!);
      return [endpoint, { cases: group.length, positives: group.filter(row => row.positive).length,
        positivePass: ratio(group.filter(row => row.positive && row.rounds[0]!.passed).length, group.filter(row => row.positive).length),
        negativeFalseMatch: ratio(group.filter(row => !row.positive && row.rounds[0]!.selected.length).length, group.filter(row => !row.positive).length),
        passed: ratio(first.filter(row => row.passed).length, first.length), requiredPassed: ratio(group.filter(row => row.status === "required" && row.rounds[0]!.passed).length, group.filter(row => row.status === "required").length),
        recallAt1: mean(first.map(row => row.scores.atK["1"]!.recall.value)), recallAt5: mean(first.map(row => row.scores.atK["5"]!.recall.value)), mrr: mean(first.map(row => row.scores.atK["5"]!.reciprocalRank)),
        miss: ratio(first.reduce((n, row) => n + row.scores.miss.numerator, 0), first.reduce((n, row) => n + row.scores.miss.denominator, 0)),
        falseSelection: ratio(first.reduce((n, row) => n + row.scores.falseSelection.numerator, 0), first.reduce((n, row) => n + row.scores.falseSelection.denominator, 0)),
        securityLeakage: ratio(group.filter(row => row.category === "security_boundary" && row.rounds.some(round => round.scores.forbiddenSelected.length)).length, group.filter(row => row.category === "security_boundary").length),
        stability: ratio(group.filter(row => row.stable).length, group.length), latency: latencySummary(group.flatMap(row => row.rounds.map(round => round.elapsedMs))) }];
    }));
    return { sourceLedgerFingerprint: fixture.fingerprint, ranking, candidateSelection, maxVerificationCandidates: options.maxVerificationCandidates ?? (candidateSelection === "bidirectional_rescue" ? 4 : 1),
      reranker: reranker?.fingerprint() ?? null, rerankingCandidateLimit: reranker ? options.rerankingCandidateLimit ?? 20 : null, rerankerPreparationMs,
      verifier: pairVerifier?.fingerprint() ?? null, verifierPreparationMs, dataset: file.split("/").at(-1), sha256: createHash("sha256").update(readFileSync(file)).digest("hex"), mode,
      model: provider.model, frozenPolicy: { minScore: .62, minMargin: .14, minimumCandidates: 2 }, indexing, summary, rows };
  } finally {
    if (service) await service.closeGracefully(30000);
    else {
      try { if (dense) await dense.close(); else {
        const settled = await Promise.allSettled([pairVerifier?.close(), reranker?.close()]);
        const failure = settled.find(result => result.status === "rejected"); if (failure?.status === "rejected") throw failure.reason;
      } }
      finally { await store?.close(); }
    }
    rmSync(root, { recursive: true, force: true });
  }
}
