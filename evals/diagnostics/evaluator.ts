import { readFileSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { performance } from "node:perf_hooks";
import { pathToFileURL } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import { isDeepStrictEqual } from "node:util";
import { z } from "zod";
import type { MemoryStore } from "../../src/core/memory/contracts.js";
import type { CandidateSearchRequest, CandidateSearchResult } from "../../src/core/retrieval/contracts.js";
import type { ContextPackItem, FactAssessment, ResolvedMemory } from "../../src/shared/types.js";
import { recallInputSchema } from "../../src/shared/types.js";
import { candidateRuntime } from "../candidates/runtime.js";
import { hash, sourceEvidence, BACKENDS, type Backend } from "../baseline/evaluator.js";
import { ACTOR, ENDPOINTS, SETTINGS, type DiagnosticCase } from "./dataset.js";
import { assertObservation, diagnose, rowSchema, summarize, valueHash, type DiagnosticRow, type Observation, type Projection, type Trace } from "./analysis.js";

function project(label: string, memory: ResolvedMemory): Projection {
  const { retrieval: _retrieval, ...snapshot } = memory;
  return { label, id: memory.id, eventId: memory.sourceEventId, version: memory.version, valueHash: valueHash(memory.value), snapshotHash: valueHash(snapshot),
    citationHash: hash(JSON.stringify({ key: memory.key, value: memory.value, kind: memory.kind, scope: memory.scope, taskId: memory.taskId,
      fact: memory.fact, memoryId: memory.id, sourceEventId: memory.sourceEventId, version: memory.version, sourceAgentId: memory.sourceAgentId })) };
}
function traceFor(input: CandidateSearchRequest, result: CandidateSearchResult, label: (memory: ResolvedMemory) => string): Trace {
  if (result.channel === "dense") throw new Error("Diagnostics v1 accepts lexical channels only; use the Dense integration evaluator");
  return { channel: result.channel, query: input.query ?? "", limit: input.limit ?? 20, requireUserConfirmed: input.requireUserConfirmed ?? false,
    status: result.status, implementation: result.implementation, truncated: result.truncated,
    ...(result.lexicalFallback ? { lexicalFallback: result.lexicalFallback } : {}),
    hits: result.hits.map(hit => {
      if ((hit.score.model === "cosine_similarity" || hit.score.model === "cross_encoder_logit") || hit.match.type === "semantic_similarity" || hit.match.reason === "vector_neighbour") throw new Error("Unexpected Dense evidence in lexical diagnostics");
      return { memory: project(label(hit.memory), hit.memory), rank: hit.channelRank, rankMeaning: hit.rankMeaning,
      score: hit.score, matchType: hit.match.type, matchReason: hit.match.reason, ...(hit.match.correction ? { correction: hit.match.correction } : {}) }; }) };
}
async function measure(source: string, backend: Backend, item: DiagnosticCase, round: number, lexicalFallback: "off" | "latin_one_edit"): Promise<DiagnosticRow[]> {
  const serviceModule = await import(pathToFileURL(join(source, "src/core/memory-service.ts")).href) as typeof import("../../src/core/application/memory-service.js");
  const retrievalModule = await import(pathToFileURL(join(source, "src/core/retrieval.ts")).href) as typeof import("../../src/core/retrieval/pipeline.js");
  const runtime = await candidateRuntime(source, backend);
  const policy = { candidateLimit: item.candidateLimit, lexicalFallback };
  const fixtures: Projection[] = [], current = new Map<string, { label: string; memory: ResolvedMemory }>();
  const label = (memory: ResolvedMemory) => fixtures.find(record => record.id === memory.id && record.eventId === memory.sourceEventId)?.label ?? "unknown";
  let calls: Array<{ input: CandidateSearchRequest; result: CandidateSearchResult }> = [];
  const store = runtime.store;
  if (!store.searchCandidates) { await runtime.close(); throw new Error("Scored candidate API required for diagnostics"); }
  const observed: MemoryStore = {
    ...(store.lexicalFallbackVersion ? { lexicalFallbackVersion: store.lexicalFallbackVersion } : {}),
    appendRemember: input => store.appendRemember(input), appendForget: (...args) => store.appendForget(...args),
    recall: input => store.recall(input), history: input => store.history(input),
    ...(store.list ? { list: input => store.list!(input) } : {}),
    ...(store.readFactGroup ? { readFactGroup: input => store.readFactGroup!(input) } : {}),
    searchCandidates: async input => {
      const result = await store.searchCandidates!(input);
      calls.push({ input: structuredClone(input), result: structuredClone(result) });
      return result;
    },
  };
  const service = new serviceModule.MemoryService(observed, policy, { defaultTokenBudget: 4096, maxTokenBudget: 4096, maxMemories: 20, requireUserConfirmed: true });
  const replay = new retrievalModule.RetrievalPipeline(store, policy);
  const rows: DiagnosticRow[] = [];
  try {
    for (const spec of item.memories) {
      const receipt = await service.remember({ ...spec, userId: spec.userId ?? ACTOR.userId, agentId: spec.agentId ?? "baseline-fictional-seeder",
        kind: "user_preference", scope: spec.scope ?? "user", sensitivity: spec.sensitivity ?? "public", userConfirmed: spec.userConfirmed ?? true,
        idempotencyKey: `diagnostic:${item.id}:${spec.idempotencyKey ?? spec.label}`, metadata: { fictional: true } });
      fixtures.push(project(spec.label, receipt.current)); current.set(receipt.current.id, { label: spec.label, memory: receipt.current });
      await delay(SETTINGS.writeSpacingMs);
    }
    for (const endpoint of ENDPOINTS) {
      const observations: Observation[] = [];
      const input = { ...ACTOR, query: item.query, scope: item.scope, taskId: item.taskId, includePrivate: false };
      for (let repeat = 0; repeat < SETTINGS.repeats; repeat++) {
        calls = [];
        const observation: Observation = { traces: [], probes: [], ranked: [], selected: [], omissions: [], factOmissions: [], answer: null, budget: null, contextBytes: null, error: null, elapsedMs: 0 };
        const factOmissions: Array<{ memoryId: string; assessment: FactAssessment }> = [];
        let packItems: ContextPackItem[] | undefined;
        const started = performance.now();
        try {
          if (endpoint === "recall") {
            const result = await service.recall({ ...input, limit: 5 });
            observation.selected = result.memories.map(memory => project(label(memory), memory));
            factOmissions.push(...result.retrieval?.factReview?.omitted ?? []);
          } else if (endpoint === "context") {
            const result = await service.context({ ...input, tokenBudget: item.tokenBudget, maxMemories: item.limit ?? 8 });
            packItems = result.items;
            observation.budget = { used: result.budget.usedTokens, requested: result.budget.requestedTokens };
            observation.contextBytes = Buffer.byteLength(result.context, "utf8");
            observation.omissions = result.omitted.map(omitted => ({ label: current.get(omitted.memoryId)?.label ?? "unknown", reason: omitted.reason }));
            factOmissions.push(...result.retrieval?.factReview?.omitted ?? []);
          } else {
            const result = await service.query({ ...input, subqueries: item.subqueries, tokenBudget: item.tokenBudget, maxMemories: item.limit ?? 8 });
            packItems = result.contextPack.items;
            observation.ranked = result.evidence.map(evidence => project(label(evidence.memory), evidence.memory));
            observation.budget = { used: result.contextPack.budget.usedTokens, requested: result.contextPack.budget.requestedTokens };
            observation.contextBytes = Buffer.byteLength(result.contextPack.context, "utf8");
            observation.omissions = result.contextPack.omitted.map(omitted => ({ label: current.get(omitted.memoryId)?.label ?? "unknown", reason: omitted.reason }));
            factOmissions.push(...result.factReview?.omitted ?? [], ...result.steps.flatMap(step => step.factReview?.omitted ?? []));
            if (!result.answer) throw new Error("Missing answer contract");
            observation.answer = { status: result.answer.status, statements: result.answer.statements.map(statement => ({ citationId: statement.citationId, valueHash: valueHash(statement.value) })),
              citations: result.answer.citations.map(({ id, memoryId, sourceEventId, version, contentHash }) => ({ id, memoryId, sourceEventId, version, contentHash })),
              coveredQueries: result.answer.coverage.coveredQueries, totalQueries: result.answer.coverage.totalQueries };
            if (result.execution.stoppedReason === "timeout") observation.error = "execution_timeout";
          }
        } catch (error) {
          const code = error && typeof error === "object" && "code" in error ? error.code : null;
          observation.error = code === "READ_TIMEOUT" || code === "RUNTIME_BUSY" || code === "STORAGE_ERROR" || code === "VALIDATION_ERROR" ? code : "unexpected_error";
        }
        observation.elapsedMs = performance.now() - started;
        observation.traces = calls.map(call => traceFor(call.input, call.result, label));
        // These are separately labelled offline probes, never inputs to the original response.
        for (const call of calls) {
          const request = { ...call.input, limit: SETTINGS.probeLimit };
          observation.probes.push(traceFor(request, await store.searchCandidates!(request), label));
        }
        if (!observation.error && endpoint !== "query") {
          const result = await replay.recall(recallInputSchema.parse({ ...input, limit: 100 }), { requireUserConfirmed: endpoint !== "recall" });
          observation.ranked = result.memories.map(memory => project(label(memory), memory));
        }
        if (packItems) observation.selected = packItems.map(selected => {
          const seeded = current.get(selected.memoryId);
          if (!seeded) throw new Error("Unknown selected fixture");
          // Context has fewer fields than ResolvedMemory; all exposed value/version/citation fields come from the actual item.
          return project(seeded.label, { ...seeded.memory, id: selected.memoryId, key: selected.key, value: selected.value, scope: selected.scope,
            taskId: selected.taskId, kind: selected.kind, version: selected.version, sourceEventId: selected.sourceEventId,
            sourceAgentId: selected.sourceAgentId, fact: selected.fact, updatedAt: selected.updatedAt });
        });
        observation.factOmissions = [...new Map(factOmissions.map(omitted => [`${omitted.memoryId}/${omitted.assessment.status}`, {
          label: current.get(omitted.memoryId)?.label ?? "unknown", status: omitted.assessment.status, reason: omitted.assessment.reason }])).values()];
        assertObservation(item, endpoint, fixtures, observation);
        observations.push(observation);
      }
      rows.push({ backend, id: item.id, endpoint, round, fixture: fixtures, observations });
    }
  } finally { await service.close(); await runtime.close(); }
  return rows;
}

export function deriveReport(rows: DiagnosticRow[], cases: DiagnosticCase[]) {
  const diagnostics = rows.map(row => ({ backend: row.backend, id: row.id, endpoint: row.endpoint, round: row.round,
    partition: cases.find(item => item.id === row.id)!.partition,
    repeats: row.observations.map(observation => diagnose(cases.find(item => item.id === row.id)!, row.endpoint, observation)) }));
  const stable = rows.map(row => ({ backend: row.backend, id: row.id, endpoint: row.endpoint, round: row.round,
    stable: row.observations.every(observation => isDeepStrictEqual({ selected: observation.selected, traces: observation.traces, ranked: observation.ranked, answer: observation.answer },
      { selected: row.observations[0]!.selected, traces: row.observations[0]!.traces, ranked: row.observations[0]!.ranked, answer: row.observations[0]!.answer })) }));
  const rebuild = [...new Set(rows.map(row => `${row.backend}/${row.endpoint}/${row.id}`))].map(key => {
    const group = rows.filter(row => `${row.backend}/${row.endpoint}/${row.id}` === key);
    return { key, stable: group.every(row => isDeepStrictEqual(row.observations[0]!.selected.map(record => record.label), group[0]!.observations[0]!.selected.map(record => record.label))) };
  });
  const requiredFailures = diagnostics.filter(row => {
    const item = cases.find(item => item.id === row.id)!;
    return (row.endpoint === "recall" ? item.recallStatus ?? item.status : item.status) === "required" && row.repeats.some(result => !result.passed);
  }).map(row => `${row.backend}/${row.endpoint}/${row.id}@${row.round}`);
  const errors = rows.filter(row => row.observations.some(observation => observation.error)).map(row => `${row.backend}/${row.endpoint}/${row.id}@${row.round}`);
  const leaks = diagnostics.filter(row => row.repeats.some(result => [result.security, result.candidateSecurity, result.replaySecurity].some(group => Object.values(group).some(metric => metric.numerator)))).map(row => `${row.backend}/${row.endpoint}/${row.id}@${row.round}`);
  const semanticValueFailures = diagnostics.filter(row => row.repeats.some(result => result.issues.some(issue => issue.stage === "fact_value"))).map(row => `${row.backend}/${row.endpoint}/${row.id}@${row.round}`);
  const policyContradictions = diagnostics.filter(row => row.repeats.some(result => result.issues.some(issue => issue.stage === "judgment_policy_conflict"))).map(row => `${row.backend}/${row.endpoint}/${row.id}@${row.round}`);
  return { diagnostics, summary: summarize(rows, cases), stable, rebuild,
    gate: { passed: !requiredFailures.length && !errors.length && !leaks.length && !semanticValueFailures.length && !policyContradictions.length && stable.every(row => row.stable) && rebuild.every(row => row.stable),
      requiredFailures, errors, leaks, semanticValueFailures, policyContradictions, challengesBlockDiagnosticTool: false } };
}
export function evaluatorHash(root = resolve(".")) {
  const files = [...readdirSync(join(root, "evals/diagnostics")).filter(name => name.endsWith(".ts")).map(name => `evals/diagnostics/${name}`),
    "evals/baseline/metrics.ts", "evals/baseline/dataset.ts", "evals/baseline/evaluator.ts", "evals/candidates/runtime.ts"];
  return valueHash(files.sort().map(name => [name, hash(readFileSync(join(root, name)))]));
}
const COVERAGE = { partitions: ["legacy", "development", "acceptance_exposed"], nativePostgres: false, heldout: false, diagnosticMutatesSource: false,
  semanticAnswer: false, queryIsNewObservation: true, latency: "small synthetic fixtures; excludes diagnostic replay, no SLO", rebuild: "selected label order; random ids intentionally differ" };
export async function evaluateDiagnostics(source: string, cases: DiagnosticCase[], backends: readonly Backend[] = BACKENDS, lexicalFallback: "off" | "latin_one_edit" = "off") {
  if (!backends.length || new Set(backends).size !== backends.length || backends.some(backend => !BACKENDS.includes(backend))) throw new Error("Invalid diagnostic backends");
  const evidence = sourceEvidence(source), rows: DiagnosticRow[] = [];
  if (!["off", "latin_one_edit"].includes(lexicalFallback)) throw new Error("Invalid diagnostic policy");
  for (const backend of backends) for (let round = 1; round <= SETTINGS.rounds; round++) for (const item of cases) rows.push(...await measure(source, backend, item, round, lexicalFallback));
  if (!isDeepStrictEqual(evidence, sourceEvidence(source))) throw new Error("Source changed while diagnosing");
  return { format: "core-diagnostics-v1" as const, evidence,
    comparable: { datasetHash: valueHash(cases), evaluatorHash: evaluatorHash(), lockHash: evidence.lockHash, node: process.version, backends: [...backends], settings: SETTINGS, lexicalFallback },
    coverage: structuredClone(COVERAGE),
    ...deriveReport(rows, cases), rows };
}
export type DiagnosticReport = Awaited<ReturnType<typeof evaluateDiagnostics>>;
export function validateReport(raw: unknown, cases: DiagnosticCase[]): DiagnosticReport {
  const envelope = z.object({ format: z.literal("core-diagnostics-v1"), comparable: z.object({ datasetHash: z.string(), evaluatorHash: z.string(), lockHash: z.string(), node: z.string(),
    backends: z.array(z.enum(["sqlite", "inmemory", "json", "postgres-pg-mem"])).min(1), settings: z.unknown(), lexicalFallback: z.enum(["off", "latin_one_edit"]) }).strict(), rows: z.array(rowSchema),
    diagnostics: z.unknown(), summary: z.unknown(), stable: z.unknown(), rebuild: z.unknown(), gate: z.unknown(),
    evidence: z.object({ commit: z.string().regex(/^[a-f0-9]{40}$/), sourceHash: z.string().regex(/^[a-f0-9]{64}$/), lockHash: z.string().regex(/^[a-f0-9]{64}$/), trackedChanges: z.array(z.string()) }).strict(), coverage: z.unknown() }).strict().parse(raw);
  if (envelope.comparable.datasetHash !== valueHash(cases) || envelope.comparable.evaluatorHash !== evaluatorHash()
    || !isDeepStrictEqual(envelope.comparable.settings, SETTINGS) || new Set(envelope.comparable.backends).size !== envelope.comparable.backends.length
    || envelope.comparable.lockHash !== envelope.evidence.lockHash || !isDeepStrictEqual(envelope.coverage, COVERAGE)) throw new Error("Incomparable diagnostic contract");
  const key = (row: DiagnosticRow) => `${row.backend}/${row.endpoint}/${row.id}/${row.round}`;
  const expectedKeys = envelope.comparable.backends.flatMap(backend => cases.flatMap(item => ENDPOINTS.flatMap(endpoint => [1, 2, 3].map(round => `${backend}/${endpoint}/${item.id}/${round}`))));
  if (envelope.rows.length !== expectedKeys.length || new Set(envelope.rows.map(key)).size !== expectedKeys.length || envelope.rows.some(row => !expectedKeys.includes(key(row)))) throw new Error("Incomplete diagnostic grid");
  for (const row of envelope.rows) for (const observation of row.observations) assertObservation(cases.find(item => item.id === row.id)!, row.endpoint, row.fixture, observation);
  const derived = deriveReport(envelope.rows, cases);
  for (const name of ["diagnostics", "summary", "stable", "rebuild", "gate"] as const) if (!isDeepStrictEqual(envelope[name], derived[name])) throw new Error("Forged diagnostic summary");
  // All fields above are validated and rebuilt; preserve source metadata without treating it as a signature.
  return raw as DiagnosticReport;
}
export function compareDiagnostics(before: DiagnosticReport, after: DiagnosticReport, cases: DiagnosticCase[]) {
  validateReport(before, cases); validateReport(after, cases);
  if (!isDeepStrictEqual(before.comparable, after.comparable)) throw new Error("Incomparable diagnostics reports");
  const regressions: string[] = [];
  for (const row of after.rows) {
    const old = before.rows.find(previous => previous.backend === row.backend && previous.id === row.id && previous.endpoint === row.endpoint && previous.round === row.round)!;
    const item = cases.find(item => item.id === row.id)!;
    for (let repeat = 0; repeat < SETTINGS.repeats; repeat++) {
      const left = diagnose(item, row.endpoint, old.observations[repeat]!), right = diagnose(item, row.endpoint, row.observations[repeat]!);
      const rankingRegression = SETTINGS.ks.some(k => (left.score.atK[String(k)]!.recall.value ?? 0) > (right.score.atK[String(k)]!.recall.value ?? 0)
        || (left.score.atK[String(k)]!.reciprocalRank ?? 0) > (right.score.atK[String(k)]!.reciprocalRank ?? 0) || (left.score.atK[String(k)]!.ndcg ?? 0) > (right.score.atK[String(k)]!.ndcg ?? 0));
      if ((left.passed && !right.passed) || rankingRegression || right.score.falseSelection.numerator > left.score.falseSelection.numerator || right.score.miss.numerator > left.score.miss.numerator) regressions.push(`${row.backend}/${row.endpoint}/${row.id}@${row.round}/${repeat + 1}`);
    }
  }
  return { passed: after.gate.passed && !regressions.length, regressions };
}
