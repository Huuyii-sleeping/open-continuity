import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { z } from "zod";
import { mean, ratio, scoreRanking } from "../baseline/metrics.js";
import { ACTOR, judgmentFor, SETTINGS, type DiagnosticCase, type Endpoint } from "./dataset.js";
import { oneWordEdit } from "../../src/core/retrieval/full-text/lexical-fallback.js";

/** Canonical values for offline comparisons; not the runtime citation hash model. */
export function valueHash(value: unknown): string {
  const canonical = (item: unknown): unknown => Array.isArray(item) ? item.map(canonical)
    : item && typeof item === "object" ? Object.fromEntries(Object.entries(item).sort(([a], [b]) => a.localeCompare(b)).map(([key, value]) => [key, canonical(value)])) : item;
  return createHash("sha256").update(JSON.stringify(canonical(value))).digest("hex");
}
const hashSchema = z.string().regex(/^[a-f0-9]{64}$/);
export const projectionSchema = z.object({ label: z.string(), id: z.string().min(1), eventId: z.string().min(1), version: z.number().int().positive(),
  valueHash: hashSchema, snapshotHash: hashSchema, citationHash: hashSchema }).strict();
export type Projection = z.infer<typeof projectionSchema>;
const scoreSchema = z.discriminatedUnion("model", [
  z.object({ model: z.literal("none"), value: z.null(), direction: z.literal("not_applicable") }).strict(),
  z.object({ model: z.literal("fts5_bm25"), value: z.number().finite(), direction: z.literal("lower_is_better") }).strict(),
  z.object({ model: z.literal("token_edit_distance"), value: z.literal(1), direction: z.literal("lower_is_better") }).strict(),
]);
const correctionSchema = z.object({ queryToken: z.string().regex(/^[a-z]{5,32}$/), matchedToken: z.string().regex(/^[a-z]+$/), edit: z.enum(["insert", "delete", "substitute", "transpose"]) }).strict();
const hitSchema = z.object({ memory: projectionSchema, rank: z.number().int().positive(), rankMeaning: z.enum(["relevance", "filter_order", "match_order"]),
  score: scoreSchema, matchType: z.enum(["exact_key", "structured_filter", "lexical_terms", "literal_substring", "one_edit_terms"]),
  matchReason: z.enum(["key_equals", "explicit_filters", "all_literal_terms", "literal_contains", "all_terms_one_edit"]), correction: correctionSchema.optional() }).strict();
const fallbackReceiptSchema = z.object({ version: z.literal("latin-one-edit-v1"), used: z.boolean(), reason: z.enum(["literal_hit", "unsupported_query", "literal_miss"]),
  probes: z.number().int().min(0).max(8), inspected: z.number().int().min(0).max(100), boundedOut: z.number().int().min(0).max(100), probeLimit: z.literal(100), truncated: z.boolean() }).strict();
export const traceSchema = z.object({ channel: z.enum(["exact", "structured", "full_text"]), query: z.string(), limit: z.number().int().min(1).max(100),
  requireUserConfirmed: z.boolean(), truncated: z.boolean(), status: z.enum(["ok", "skipped"]), implementation: z.string().min(1),
  hits: z.array(hitSchema).max(100), lexicalFallback: fallbackReceiptSchema.optional() }).strict();
export type Trace = z.infer<typeof traceSchema>;
export const observationSchema = z.object({ traces: z.array(traceSchema).max(24), probes: z.array(traceSchema).max(24),
  ranked: z.array(projectionSchema).max(300), selected: z.array(projectionSchema).max(100),
  omissions: z.array(z.object({ label: z.string(), reason: z.enum(["token_budget", "max_memories", "fact_unresolved"]) }).strict()),
  factOmissions: z.array(z.object({ label: z.string(), status: z.string().min(1), reason: z.string().min(1) }).strict()),
  answer: z.object({ status: z.enum(["evidence_ready", "partial", "abstain"]),
    statements: z.array(z.object({ citationId: z.string(), valueHash: hashSchema }).strict()),
    citations: z.array(z.object({ id: z.string(), memoryId: z.string(), sourceEventId: z.string(), version: z.number().int().positive(), contentHash: hashSchema }).strict()),
    coveredQueries: z.number().int().nonnegative(), totalQueries: z.number().int().nonnegative() }).strict().nullable(),
  budget: z.object({ used: z.number().int().nonnegative(), requested: z.number().int().min(64).max(4096) }).strict().nullable(),
  contextBytes: z.number().int().nonnegative().nullable(),
  elapsedMs: z.number().finite().nonnegative(), error: z.enum(["READ_TIMEOUT", "RUNTIME_BUSY", "STORAGE_ERROR", "VALIDATION_ERROR", "execution_timeout", "unexpected_error"]).nullable(),
}).strict();
export type Observation = z.infer<typeof observationSchema>;
export const rowSchema = z.object({ backend: z.enum(["sqlite", "inmemory", "json", "postgres-pg-mem"]), id: z.string(), round: z.number().int().min(1).max(3),
  endpoint: z.enum(["recall", "context", "query"]), fixture: z.array(projectionSchema), observations: z.array(observationSchema).length(3) }).strict();
export type DiagnosticRow = z.infer<typeof rowSchema>;

export function boundaryLabels(item: DiagnosticCase, endpoint: Endpoint) {
  const boundaries: Record<string, string[]> = { user: [], agent: [], task: [], private: [], userConfirmed: [], explicitScope: [] };
  for (const spec of item.memories) {
    if (spec.userId && spec.userId !== ACTOR.userId) boundaries.user!.push(spec.label);
    if (spec.scope === "agent" && (spec.agentId ?? "baseline-fictional-seeder") !== ACTOR.agentId) boundaries.agent!.push(spec.label);
    if (spec.scope === "task" && spec.taskId !== item.taskId) boundaries.task!.push(spec.label);
    if (spec.sensitivity === "private") boundaries.private!.push(spec.label);
    if (endpoint !== "recall" && spec.userConfirmed === false) boundaries.userConfirmed!.push(spec.label);
    if (item.scope && (spec.scope ?? "user") !== item.scope) boundaries.explicitScope!.push(spec.label);
  }
  return boundaries;
}
const labels = (items: Projection[]) => items.map(item => item.label);
export function diagnose(item: DiagnosticCase, endpoint: Endpoint, observation: Observation) {
  const expected = judgmentFor(item, endpoint), selected = labels(observation.selected), ranked = labels(observation.ranked);
  const queryTraces = observation.traces.filter(trace => trace.channel !== "structured");
  const candidateLabels = queryTraces.flatMap(trace => trace.hits.map(hit => hit.memory.label));
  const probes = observation.probes.filter(trace => trace.channel !== "structured");
  const issues: Array<{ label: string; stage: string; reason: string; evidence: string }> = [];
  for (const label of expected.relevant.filter(label => !selected.includes(label))) {
    const fact = observation.factOmissions.find(omission => omission.label === label);
    const omitted = observation.omissions.find(omission => omission.label === label);
    const boundary = Object.entries(boundaryLabels(item, endpoint)).find(([, labels]) => labels.includes(label));
    const probeFound = probes.some(trace => trace.hits.some(hit => hit.memory.label === label));
    if (observation.error) issues.push({ label, stage: "runtime", reason: observation.error, evidence: "actual_response" });
    else if (boundary) issues.push({ label, stage: "judgment_policy_conflict", reason: boundary[0], evidence: "fixed_fixture_policy" });
    else if (fact) issues.push({ label, stage: "fact_policy", reason: fact.status, evidence: "actual_fact_receipt" });
    else if (!candidateLabels.includes(label)) issues.push({ label, stage: "retrieval",
      reason: probeFound ? "candidate_window" : probes.some(trace => trace.truncated) ? "unobserved_beyond_probe" : "no_observed_lexical_match",
      evidence: "separate_bounded_probe" });
    else if (!ranked.includes(label)) issues.push({ label, stage: "unattributed", reason: "candidate_not_in_evidence", evidence: "candidate_vs_evidence" });
    else if (omitted) issues.push({ label, stage: "context", reason: omitted.reason, evidence: "actual_omission_receipt" });
    else issues.push({ label, stage: endpoint === "recall" ? "ranking" : "context", reason: endpoint === "recall" ? "output_top_k" : "selection_not_observed", evidence: "ranked_vs_selected" });
  }
  for (const label of selected.filter(label => !expected.relevant.includes(label))) issues.push({ label, stage: "relevance", reason: "unrelated_selection", evidence: "fixed_judgment" });
  // An omission receipt is the proximate budget cause; do not hide a higher-ranked distractor behind it.
  for (const label of expected.relevant.filter(label => ranked.includes(label) && !selected.includes(label))) {
    if (selected.some(other => !expected.relevant.includes(other) && ranked.indexOf(other) >= 0 && ranked.indexOf(other) < ranked.indexOf(label))) {
      issues.push({ label, stage: "ranking", reason: "relevant_below_selected_distractor", evidence: "ranked_vs_selected" });
    }
  }
  const orderMatches = !expected.ordered || isDeepStrictEqual(selected.slice(0, expected.ordered.length), expected.ordered);
  // A missing candidate makes the judgment fail, but cannot prove a ranking defect.
  if (!orderMatches && expected.ordered!.every(label => ranked.includes(label)) && selected.length >= expected.ordered!.length) {
    issues.push({ label: "order", stage: "ranking", reason: "annotated_order_mismatch", evidence: "fixed_judgment_with_observed_candidates" });
  }
  for (const value of expected.values ?? []) {
    const actual = observation.selected.find(record => record.label === value.label);
    if (actual && (actual.valueHash !== valueHash(value.value) || (value.version !== undefined && actual.version !== value.version))) issues.push({ label: value.label, stage: "fact_value", reason: "value_or_version_mismatch", evidence: "fixed_judgment" });
  }
  const candidateExposure = new Set(observation.traces.flatMap(trace => trace.hits.map(hit => hit.memory.label)));
  const replayExposure = new Set([...ranked, ...observation.probes.flatMap(trace => trace.hits.map(hit => hit.memory.label))]);
  const measureSecurity = (exposure: Set<string>) => Object.fromEntries(Object.entries(boundaryLabels(item, endpoint)).map(([name, forbidden]) => [name,
    ratio(forbidden.filter(label => exposure.has(label)).length, forbidden.length)]));
  const responseExposure = new Set([...selected, ...observation.omissions.map(item => item.label), ...observation.factOmissions.map(item => item.label),
    ...(endpoint === "query" ? ranked : [])]);
  const security = measureSecurity(responseExposure), candidateSecurity = measureSecurity(candidateExposure), replaySecurity = measureSecurity(replayExposure);
  const exposure = new Set([...selected, ...candidateExposure, ...replayExposure]);
  // Eligibility is inferred from fixture policy; absence alone does not prove that a literal match was filtered.
  const policyIneligibleUnexposed = Object.entries(boundaryLabels(item, endpoint)).flatMap(([boundary, forbidden]) => forbidden.filter(label => !exposure.has(label)).map(label => ({ label, boundary })));
  const score = scoreRanking(selected, expected, SETTINGS.ks, item.grades);
  return { issues, score, security, candidateSecurity, replaySecurity, policyIneligibleUnexposed, orderMatches, factExclusions: observation.factOmissions,
    candidateRecall: ratio(new Set(expected.relevant.filter(label => candidateLabels.includes(label))).size, expected.relevant.length),
    passed: !observation.error && !issues.length && orderMatches && ![security, candidateSecurity, replaySecurity].some(group => Object.values(group).some(metric => metric.numerator)) && score.duplicates === 0 };
}

export function assertObservation(item: DiagnosticCase, endpoint: Endpoint, fixture: Projection[], observation: Observation) {
  const known = new Map(fixture.map(record => [record.label, record]));
  if (known.size !== fixture.length || fixture.length !== item.memories.length || item.memories.some(spec => !known.has(spec.label))) throw new Error("Incomplete fixture evidence");
  const states = new Map<string, { record: Projection; value: unknown }>();
  const merge = (left: unknown, right: unknown): unknown => {
    if (!left || !right || typeof left !== "object" || typeof right !== "object" || Array.isArray(left) || Array.isArray(right)) return right;
    const a = Object.fromEntries(Object.entries(left)), b = Object.fromEntries(Object.entries(right));
    return Object.fromEntries([...new Set([...Object.keys(a), ...Object.keys(b)])].map(key => [key,
      Object.hasOwn(b, key) ? Object.hasOwn(a, key) ? merge(a[key], b[key]) : b[key] : a[key]]));
  };
  for (const spec of item.memories) {
    const record = known.get(spec.label)!;
    const scope = spec.scope ?? "user";
    const identity = JSON.stringify([spec.userId ?? ACTOR.userId, scope, scope === "task" ? spec.taskId : scope === "agent" ? spec.agentId ?? "baseline-fictional-seeder" : null, spec.key]);
    const previous = states.get(identity);
    const value = spec.writeMode === "merge" ? merge(previous?.value, spec.value) : spec.value;
    if (record.version !== (previous?.record.version ?? 0) + 1 || record.valueHash !== valueHash(value)
      || (previous && previous.record.id !== record.id) || (spec.expectedVersion !== undefined && spec.expectedVersion !== (previous?.record.version ?? 0))) throw new Error("Fixture value/version contract changed");
    states.set(identity, { record, value });
  }
  const latest = new Map([...states.values()].map(state => [state.record.id, state.record]));
  for (const records of [observation.ranked, observation.selected, ...[...observation.traces, ...observation.probes].map(trace => trace.hits.map(hit => hit.memory))]) {
    if (new Set(records.map(record => record.id)).size !== records.length) throw new Error("Duplicate observation memory");
    for (const record of records) if (!isDeepStrictEqual(record, known.get(record.label)) || !isDeepStrictEqual(record, latest.get(record.id))) throw new Error("Unknown, stale or altered snapshot");
  }
  if (observation.probes.length !== observation.traces.length) throw new Error("Missing candidate probe");
  observation.traces.forEach((trace, index) => {
    const probe = observation.probes[index]!;
    if (trace.limit !== item.candidateLimit || trace.requireUserConfirmed !== (endpoint !== "recall")
      || probe.limit !== SETTINGS.probeLimit || trace.query !== probe.query || trace.channel !== probe.channel
      || trace.requireUserConfirmed !== probe.requireUserConfirmed) throw new Error("Mismatched candidate probe");
    for (const batch of [trace, probe]) {
      if (batch.hits.length > batch.limit || (batch.status === "skipped" && batch.hits.length)) throw new Error("Invalid candidate budget");
      const receipt = batch.lexicalFallback;
      if (receipt && (batch.channel !== "full_text" || receipt.boundedOut > receipt.inspected
        || (receipt.used !== (receipt.reason === "literal_miss")) || (!receipt.used && (receipt.probes || receipt.inspected || receipt.boundedOut))
        || (receipt.boundedOut > 0 && !receipt.truncated))) throw new Error("Invalid fallback receipt");
      batch.hits.forEach((hit, rank) => {
        if (hit.rank !== rank + 1 || (batch.channel === "structured" && hit.rankMeaning !== "filter_order")
          || (hit.score.model === "fts5_bm25" && (batch.channel !== "full_text" || hit.rankMeaning !== "relevance"))
          || (hit.score.model === "none" && hit.rankMeaning === "relevance")) throw new Error("Invalid channel evidence");
        if (hit.score.model === "token_edit_distance" && (batch.channel !== "full_text" || hit.rankMeaning !== "relevance"
          || hit.matchType !== "one_edit_terms" || hit.matchReason !== "all_terms_one_edit" || !hit.correction
          || oneWordEdit(hit.correction.queryToken, hit.correction.matchedToken) !== hit.correction.edit || !receipt?.used)) throw new Error("Invalid correction evidence");
        const previous = batch.hits[rank - 1];
        if (hit.score.model === "fts5_bm25" && previous?.score.model === "fts5_bm25" && previous.score.value > hit.score.value) throw new Error("Unsorted BM25 evidence");
      });
    }
    if (!isDeepStrictEqual(trace.hits, probe.hits.slice(0, trace.hits.length)) || (trace.truncated && probe.hits.length <= trace.hits.length && !probe.truncated)) throw new Error("Probe changed native prefix");
  });
  if (!observation.error && (!observation.traces.length || observation.traces.length % 3
    || observation.traces.some((trace, index) => trace.channel !== ["exact", "structured", "full_text"][index % 3]))) throw new Error("Incomplete actual channel calls");
  for (const omitted of [...observation.omissions, ...observation.factOmissions]) if (!known.has(omitted.label)) throw new Error("Unknown omission");
  for (const omitted of observation.factOmissions) if (!item.memories.find(spec => spec.label === omitted.label)?.fact) throw new Error("Fabricated fact declaration");
  const queryCandidates = new Set(observation.traces.filter(trace => trace.channel !== "structured").flatMap(trace => trace.hits.map(hit => hit.memory.id)));
  if (observation.ranked.some(record => !queryCandidates.has(record.id)) || observation.selected.some(record => !observation.ranked.some(candidate => candidate.id === record.id))) throw new Error("Selected evidence absent from query candidates");
  if (endpoint === "recall" && (observation.budget || observation.answer || observation.contextBytes !== null)) throw new Error("Wrong endpoint evidence");
  if (!observation.error && endpoint !== "recall" && (!observation.budget || observation.contextBytes === null || observation.budget.requested !== item.tokenBudget
    || observation.budget.used > item.tokenBudget || observation.budget.used !== Math.ceil(observation.contextBytes / 4)
    || (!observation.selected.length && observation.contextBytes !== 0))) throw new Error("Invalid Context budget");
  if (endpoint === "query" && !observation.error) {
    const answer = observation.answer;
    if (!answer || answer.citations.length !== observation.selected.length || answer.statements.length !== answer.citations.length
      || answer.totalQueries < 1 || answer.coveredQueries > answer.totalQueries || (!answer.citations.length && answer.status !== "abstain")
      || (answer.status === "evidence_ready" && (!answer.citations.length || answer.coveredQueries !== answer.totalQueries))) throw new Error("Invalid answer coverage");
    answer.citations.forEach((citation, index) => {
      const selected = observation.selected[index]!, statement = answer.statements[index]!;
      const id = "memory:" + createHash("sha256").update(JSON.stringify([selected.id, selected.eventId, selected.version, selected.citationHash])).digest("base64url");
      if (citation.id !== id || citation.memoryId !== selected.id || citation.sourceEventId !== selected.eventId || citation.version !== selected.version
        || citation.contentHash !== selected.citationHash || statement.citationId !== id || statement.valueHash !== selected.valueHash) throw new Error("Invalid exact-version citation");
    });
  }
}

export function summarize(rows: DiagnosticRow[], cases: DiagnosticCase[]) {
  const groups = [...new Set(rows.map(row => `${row.backend}/${cases.find(item => item.id === row.id)!.partition}/${row.endpoint}`))];
  return Object.fromEntries(groups.map(key => {
    const selectedRows = rows.filter(row => `${row.backend}/${cases.find(item => item.id === row.id)!.partition}/${row.endpoint}` === key);
    const observations = selectedRows.flatMap(row => row.observations.map(observation => ({ row, result: diagnose(cases.find(item => item.id === row.id)!, row.endpoint, observation) })));
    // The first repeat represents each rebuilt problem; repeats remain available separately, not multiplied into problem counts.
    const representatives = selectedRows.map(row => diagnose(cases.find(item => item.id === row.id)!, row.endpoint, row.observations[0]!));
    const reasons = [...new Set(representatives.flatMap(result => result.issues.map(issue => `${issue.stage}/${issue.reason}`)))];
    const failures = Object.fromEntries(reasons.map(reason => [reason, { affectedDistinctCases: new Set(selectedRows.filter((row, index) => representatives[index]!.issues.some(issue => `${issue.stage}/${issue.reason}` === reason)).map(row => row.id)).size,
      rebuiltObservations: representatives.filter(result => result.issues.some(issue => `${issue.stage}/${issue.reason}` === reason)).length }]));
    return [key, { distinctCases: new Set(selectedRows.map(row => row.id)).size, rebuiltObservations: selectedRows.length, technicalResponses: observations.length,
      passed: ratio(representatives.filter(result => result.passed).length, representatives.length), failures,
      candidateRecall: mean(representatives.map(result => result.candidateRecall.value)),
      atK: Object.fromEntries(SETTINGS.ks.map(k => [String(k), { recall: mean(representatives.map(result => result.score.atK[String(k)]!.recall.value)),
        mrr: mean(representatives.map(result => result.score.atK[String(k)]!.reciprocalRank)), ndcg: mean(representatives.map(result => result.score.atK[String(k)]!.ndcg)) }])),
      miss: ratio(representatives.reduce((n, result) => n + result.score.miss.numerator, 0), representatives.reduce((n, result) => n + result.score.miss.denominator, 0)),
      falseSelection: ratio(representatives.reduce((n, result) => n + result.score.falseSelection.numerator, 0), representatives.reduce((n, result) => n + result.score.falseSelection.denominator, 0)) }];
  }));
}
