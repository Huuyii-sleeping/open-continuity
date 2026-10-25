import { createHash } from "node:crypto";
import { readFileSync, readdirSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { isDeepStrictEqual } from "node:util";
import { performance } from "node:perf_hooks";
import { setTimeout as delay } from "node:timers/promises";
import { candidateSkip, parseCandidateSearch, type CandidateSearchInput, type CandidateSearchResult } from "../../src/core/candidate-search.js";
import { recallInputSchema, type ResolvedMemory } from "../../src/shared/types.js";
import { parseDataset } from "../baseline/dataset.js";
import { BACKENDS, sourceEvidence, type Backend } from "../baseline/evaluator.js";
import { latencySummary, mean, ratio, scoreRanking } from "../baseline/metrics.js";
import { parseCandidateDataset, type CandidateCase } from "./dataset.js";
import { candidateRuntime } from "./runtime.js";

const USER = "baseline-fictional-user",AGENT = "baseline-fictional-reader",KS = [1,3,5];
export type CandidateMode = "native" | "legacy";
const hash = (data: string | Buffer) => createHash("sha256").update(data).digest("hex");
export function candidateHarnessHash() {
  const root = dirname(fileURLToPath(import.meta.url));
  return hash([...readdirSync(root).filter(name => name.endsWith(".ts")).sort().map(name => `${name}:${hash(readFileSync(join(root,name)))}`),
    ...["dataset.ts","metrics.ts","evaluator.ts"].map(name => `baseline/${name}:${hash(readFileSync(join(root,"../baseline",name)))}`)].join("\n"));
}
export interface CandidateRow {
  backend: Backend; channel: CandidateCase["channel"]; dataset: CandidateCase["source"]; id: string; category: string; status: "required" | "challenge";
  round: number; requirementApplies: boolean; limit: number; selected: string[]; ranking: ReturnType<typeof scoreRanking>; passed: boolean;
  valuesMatch: boolean; stable: boolean; implementation: string; error: boolean;
  judgment: ReturnType<typeof parseDataset>["cases"][number]["expected"];
  grades: Record<string,number>;
  observed: Array<{ label: string; value: unknown; version: number }>;
  repetitions: string[][];
  boundaryLabels: Record<string,string[]>;
  latency: ReturnType<typeof latencySummary>; leakage: Record<string,ReturnType<typeof ratio>>;
  evidence: CandidateSearchResult["hits"]; ablation: null | { selected: string[]; ranking: ReturnType<typeof scoreRanking>; candidateSetComplete: true };
}

/** Reference projection, NOT a claim that phase 1 already had a candidate API.
 * Exhaust <=100 fixture candidates so confirmation is applied before the measured top-K.
 * Exact uses legacy key lookup, Structured uses legacy list, Lexical uses legacy whole-phrase lookup.
 */
export async function legacyCandidates(store: Awaited<ReturnType<typeof candidateRuntime>>["store"], input: CandidateSearchInput): Promise<ResolvedMemory[]> {
  if (candidateSkip(input)) return [];
  const request = recallInputSchema.parse({ ...input,query: input.channel === "full_text" ? input.query : undefined,key: input.channel === "exact" ? input.key ?? input.query?.trim() : input.key,limit: 100 });
  const result = input.channel === "structured" && store.list ? await store.list({ ...request, query: undefined }) : await store.recall(request);
  if (result.nextCursor) throw new Error("Legacy projection requires a complete small fixture");
  return result.memories.filter(memory => !input.requireUserConfirmed || memory.userConfirmed);
}
export function summarizeCandidates(rows: CandidateRow[]) {
  const positives = rows.filter(row => row.ranking.miss.denominator > 0);
  return {
    metricMeaning: rows[0]?.channel === "structured" ? "filter eligibility coverage, NOT answer relevance" : "candidate relevance only, NOT Context injection",
    required: ratio(rows.filter(r => r.requirementApplies && r.passed).length,rows.filter(r => r.requirementApplies).length),
    challenges: ratio(rows.filter(r => r.status === "challenge" && r.passed).length,rows.filter(r => r.status === "challenge").length),
    outsidePromisedCapability: rows.filter(r => r.status === "required" && !r.requirementApplies).map(r => ({ id: r.id,round: r.round,passed: r.passed })),
    atK: Object.fromEntries(KS.map(k => [k,{ recall: mean(positives.map(r => r.ranking.atK[k]!.recall.value)),mrr: mean(positives.map(r => r.ranking.atK[k]!.reciprocalRank)),ndcg: mean(positives.map(r => r.ranking.atK[k]!.ndcg)) }])),
    miss: ratio(rows.reduce((n,r) => n+r.ranking.miss.numerator,0),rows.reduce((n,r) => n+r.ranking.miss.denominator,0)),
    falseSelection: ratio(rows.reduce((n,r) => n+r.ranking.falseSelection.numerator,0),rows.reduce((n,r) => n+r.ranking.falseSelection.denominator,0)),
    repeatStability: ratio(rows.filter(r => r.stable).length,rows.length),
    rebuildStability: ratio([...new Set(rows.map(r => r.id))].filter(id => new Set(rows.filter(r => r.id === id).map(r => JSON.stringify(r.selected))).size === 1).length,new Set(rows.map(r => r.id)).size),
    leakage: Object.fromEntries(["user","agent","task","private","userConfirmed"].map(boundary => [boundary,ratio(rows.reduce((n,r) => n+r.leakage[boundary]!.numerator,0),rows.reduce((n,r) => n+r.leakage[boundary]!.denominator,0))])),
    currentFactSelection: ratio(rows.filter(r => ["temporal_conflict","evolution_conflict","evolution_merge"].includes(r.category) && r.passed).length,rows.filter(r => ["temporal_conflict","evolution_conflict","evolution_merge"].includes(r.category)).length),
    latency: latencySummary(rows.flatMap(r => r.latency.samplesMs)),
  };
}

export async function evaluateCandidates(source: string, corePath: string, candidatePath: string, mode: CandidateMode, backends: readonly Backend[] = BACKENDS) {
  if (!backends.length || new Set(backends).size !== backends.length || backends.some(b => !BACKENDS.includes(b))) throw new Error("Specify unique known backends");
  if (mode !== "native" && mode !== "legacy") throw new Error("Unknown candidate evaluation mode");
  const coreBytes = readFileSync(corePath),candidateBytes = readFileSync(candidatePath);
  const core = parseDataset(JSON.parse(coreBytes.toString("utf8"))),additional = parseCandidateDataset(JSON.parse(candidateBytes.toString("utf8"))),start = sourceEvidence(source),harnessHash = candidateHarnessHash();
  const coreDatasetHash = hash(coreBytes),candidateDatasetHash = hash(candidateBytes);
  const cases: CandidateCase[] = [...core.cases.map(spec => ({ source: "core-baseline-v1" as const,channel: "full_text" as const,spec,requireUserConfirmed: false,sqliteOnlyRequired: false })),...additional];
  const rows: CandidateRow[] = [];
  for (const backend of backends) for (let round=1;round<=3;round++) for (const entry of cases) {
    const rt = await candidateRuntime(source,backend),spec = entry.spec,labels = new Map<string,string>();
    const records = [...spec.memories ?? [],...spec.writes ?? []];
    try {
      for (const memory of records) {
        const saved = await rt.service.remember({ userId: memory.userId ?? USER,agentId: memory.agentId ?? "baseline-fictional-seeder",key: memory.key,value: memory.value,kind: "user_preference",scope: memory.scope ?? "user",taskId: memory.taskId,sensitivity: memory.sensitivity ?? "public",userConfirmed: memory.userConfirmed ?? true,idempotencyKey: memory.idempotencyKey ?? memory.label,expectedVersion: memory.expectedVersion,writeMode: memory.writeMode,metadata: { fictional: true } });
        labels.set(saved.current.id,memory.label); await delay(2);
      }
      const input = parseCandidateSearch({ userId: USER,agentId: AGENT,channel: entry.channel,query: spec.query,key: entry.key,kind: entry.kind,scope: spec.scope,taskId: spec.taskId,requireUserConfirmed: entry.requireUserConfirmed,limit: spec.limit ?? 5 });
      const expected = entry.source === "core-baseline-v1" ? spec.recallExpected ?? spec.expected : spec.expected;
      const status = entry.source === "core-baseline-v1" ? spec.recallStatus ?? spec.status : spec.status;
      let selected: string[] = [],first: ResolvedMemory[] = [],evidence: CandidateSearchResult["hits"] = [],implementation = mode === "legacy" ? "legacy_lookup_projection" : "unknown",stable = true,error = false;
      const samples: number[] = [],repetitions: string[][] = [];
      let ablation: CandidateRow["ablation"] = null;
      const request = async (limit = input.limit) => {
        if (mode === "legacy") return (await legacyCandidates(rt.store,{ ...input,limit })).slice(0,limit);
        if (!rt.store.searchCandidates) throw new Error("Source does not implement candidate-search-v1");
        const result = await rt.store.searchCandidates({ ...input,limit });
        if (result.status === "skipped") throw new Error("Judged fixture unexpectedly skipped");
        evidence = result.hits; implementation = result.implementation;
        return result.hits.map(h => h.memory);
      };
      try {
        await request();
        for (let repeat=0;repeat<5;repeat++) {
          const t = performance.now(),memories = await request(); samples.push(performance.now()-t);
          const observed = memories.map(m => labels.get(m.id) ?? `unknown:${m.id}`);
          repetitions.push(observed);
          if (repeat === 0) { selected = observed; first = memories; } else if (!isDeepStrictEqual(selected,observed)) stable = false;
        }
        if (mode === "native" && backend === "sqlite" && entry.channel === "full_text") {
          const result = await rt.store.searchCandidates!({ ...input,limit: 100 });
          if (result.truncated) throw new Error("Ablation needs a complete fixture before truncation");
          const timeOrdered = result.hits.map(h => h.memory).sort((a,b) => b.updatedAt.localeCompare(a.updatedAt) || b.id.localeCompare(a.id)).slice(0,input.limit).map(m => labels.get(m.id) ?? `unknown:${m.id}`);
          ablation = { selected: timeOrdered,ranking: scoreRanking(timeOrdered,expected,KS,spec.grades),candidateSetComplete: true };
        }
      } catch { error = true; stable = false; }
      const ranking = scoreRanking(selected,expected,KS,spec.grades);
      const valuesMatch = (expected.values ?? []).every(j => { const item = first[selected.indexOf(j.label)]; return item && isDeepStrictEqual(item.value,j.value) && (j.version === undefined || item.version === j.version); });
      const passed = !error && valuesMatch && ranking.miss.numerator === 0 && ranking.falseSelection.numerator === 0 && ranking.duplicates === 0 && (!expected.ordered || isDeepStrictEqual(selected.slice(0,expected.ordered.length),expected.ordered));
      const boundaryLabels: Record<string,string[]> = { user: [],agent: [],task: [],private: [],userConfirmed: [] };
      for (const memory of records) {
        if (memory.userId && memory.userId !== USER) boundaryLabels.user!.push(memory.label);
        if (memory.scope === "agent" && (memory.agentId ?? "baseline-fictional-seeder") !== AGENT) boundaryLabels.agent!.push(memory.label);
        if (memory.scope === "task" && memory.taskId !== spec.taskId) boundaryLabels.task!.push(memory.label);
        if (memory.sensitivity === "private") boundaryLabels.private!.push(memory.label);
        if (entry.requireUserConfirmed && memory.userConfirmed === false) boundaryLabels.userConfirmed!.push(memory.label);
      }
      rows.push({ backend,channel: entry.channel,dataset: entry.source,id: spec.id,category: spec.category,status,round,requirementApplies: status === "required" && (!entry.sqliteOnlyRequired || backend === "sqlite"),limit: input.limit,selected,ranking,passed,valuesMatch,stable,implementation,error,latency: latencySummary(samples),evidence,ablation,
        judgment: expected,grades: spec.grades ?? {},observed: first.map((memory,index) => ({ label: selected[index]!,value: memory.value,version: memory.version })),repetitions,boundaryLabels,
        leakage: Object.fromEntries(Object.entries(boundaryLabels).map(([b,forbidden]) => [b,ratio(selected.filter(label => forbidden.includes(label)).length,forbidden.length)])) });
    } finally { await rt.close(); }
  }
  if (!isDeepStrictEqual(start,sourceEvidence(source)) || harnessHash !== candidateHarnessHash() || coreDatasetHash !== hash(readFileSync(corePath)) || candidateDatasetHash !== hash(readFileSync(candidatePath))) throw new Error("Source, data or evaluator changed during evaluation");
  const groups = [...new Set(rows.map(r => `${r.backend}/${r.dataset}/${r.channel}`))];
  const summary = Object.fromEntries(groups.map(key => [key,summarizeCandidates(rows.filter(r => `${r.backend}/${r.dataset}/${r.channel}` === key))]));
  const failures = rows.filter(r => (r.requirementApplies && !r.passed) || r.error || r.ranking.duplicates > 0 || !r.stable || Object.values(r.leakage).some(v => v.numerator));
  const rebuildUnstable = Object.entries(summary).filter(([,s]) => s.rebuildStability.numerator !== s.rebuildStability.denominator).map(([key]) => key);
  return { format: "open-continuity-candidates-v2" as const,mode,evidence: start,comparable: { harnessHash,coreDatasetHash,candidateDatasetHash,lockHash: start.lockHash,node: process.version,rounds: 3,repeats: 5,ks: KS,backends: [...backends],caseKeys: cases.map(c => JSON.stringify([c.source,c.spec.id,c.channel])) },
    coverage: { coreJudgments: "unchanged; lexical only, recall policy",structured: "filter eligibility, not question relevance",reference: "legacy lookup projection, not a previously existing candidate API",pg: "pg-mem only; native PG contract tested separately",workspace: "NOT COVERED",contextInjection: "NOT MEASURED HERE; independent public baseline",snapshotPagination: "NOT IMPLEMENTED; candidate batches reject cursors",bm25: "global FTS corpus statistics, not per-user statistics isolation",ablation: "same complete SQLite candidate set, BM25 disabled by time reordering before K; no latency claim" },
    summary,gate: { passed: failures.length === 0 && rebuildUnstable.length === 0,failures: failures.map(r => `${r.backend}/${r.dataset}/${r.channel}/${r.id}@${r.round}`),rebuildUnstable },rows };
}
export function writeCandidateReports(directory: string, report: Awaited<ReturnType<typeof evaluateCandidates>>) {
  mkdirSync(directory,{ recursive: true });
  writeFileSync(join(directory,"raw-report.json"),JSON.stringify(report,null,2),{ flag: "wx",mode: 0o600 });
  const lines = ["# Candidate retrieval: independent results","",`Mode: ${report.mode}. Gate: ${report.gate.passed ? "PASS" : "FAIL"}. No combined quality score.`,"","Core and supplemental judgments remain separate. Structured reports measure filter coverage, NOT answer relevance. Misses and false selections remain failures; no unjudged case is counted as passed.",""];
  for (const [key,summary] of Object.entries(report.summary)) {
    const file = key.replaceAll("/","-")+".json";
    const rows = report.rows.filter(r => `${r.backend}/${r.dataset}/${r.channel}` === key);
    const identity = (row: CandidateRow) => ({ id: row.id,round: row.round,status: row.status,requirementApplies: row.requirementApplies });
    const { leakage,repeatStability,rebuildStability,latency,...quality } = summary;
    const sections = {
      quality: { summary: quality,rows: rows.map(row => ({ ...identity(row),selected: row.selected,ranking: row.ranking,passed: row.passed,valuesMatch: row.valuesMatch,error: row.error,evidence: row.evidence })) },
      security: { summary: leakage,rows: rows.map(row => ({ ...identity(row),leakage: row.leakage,error: row.error })) },
      stability: { summary: { repeatStability,rebuildStability },rows: rows.map(row => ({ ...identity(row),selected: row.selected,stable: row.stable,error: row.error })) },
      latency: { summary: latency,note: "small fixtures only; not capacity or SLO",rows: rows.map(row => ({ ...identity(row),latency: row.latency,error: row.error })) },
      ablation: { note: report.coverage.ablation,rows: rows.filter(row => row.ablation).map(row => ({ ...identity(row),native: { selected: row.selected,ranking: row.ranking },withoutBm25: row.ablation })) },
    };
    lines.push(`### ${key}`,`Required ${summary.required.numerator}/${summary.required.denominator}; challenge ${summary.challenges.numerator}/${summary.challenges.denominator}.`,"");
    for (const [section,data] of Object.entries(sections)) {
      mkdirSync(join(directory,section),{ recursive: true });
      writeFileSync(join(directory,section,file),JSON.stringify(data,null,2),{ flag: "wx",mode: 0o600 });
      lines.push(`- [${section}](${section}/${file})`);
    }
    lines.push("");
  }
  lines.push("","## Evidence limits",...Object.entries(report.coverage).map(([key,value]) => `- ${key}: ${value}`));
  writeFileSync(join(directory,"README.md"),lines.join("\n")+"\n",{ flag: "wx",mode: 0o600 });
}
