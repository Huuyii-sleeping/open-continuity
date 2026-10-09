import { isDeepStrictEqual } from "node:util";
import { readFileSync } from "node:fs";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import { extractMemoryCandidates } from "../../src/capture/candidate-extractor.js";
import { sanitizeConversationItem } from "../../src/capture/sensitivity.js";
import type { CaptureQuality, ConversationItem } from "../../src/capture/types.js";
import { MemoryService } from "../../src/core/memory-service.js";
import { SqliteMemoryStore } from "../../src/sqlite/sqlite-memory-store.js";
import type { MemoryKind, Sensitivity } from "../../src/shared/types.js";

export interface QualityDataset {
  version: string;
  description: string;
  rounds: number;
  thresholds: QualityThresholds;
  capture: QualityCaptureCase[];
  retrieval: QualityRetrievalCase[];
}

export interface QualityThresholds {
  requiredCasePassRate: number;
  securityLeakageRate: number;
}

interface QualityCaptureExpected { kind: MemoryKind; value: string; maxConfidence?: number; }
interface QualityCaptureCase { id: string; status: "required" | "challenge"; category: string; type: string; text: string; quality: CaptureQuality; expected: QualityCaptureExpected[]; }
interface QualityMemory { label: string; key: string; value: unknown; sensitivity?: Sensitivity; userConfirmed?: boolean; }
interface QualityWrite extends QualityMemory { idempotencyKey: string; expectedVersion?: number; writeMode?: "replace" | "merge"; }
interface QualityExpected { relevant: string[]; forbidden: string[]; ordered?: string[]; values?: Array<{ label: string; value: unknown; version?: number }>; }
interface QualityRetrievalCase { id: string; status: "required" | "challenge"; category: string; query: string; limit?: number; memories?: QualityMemory[]; writes?: QualityWrite[]; expected: QualityExpected; }
interface QualityCaseResult { id: string; category: string; status: "required" | "challenge"; round: number; passed: boolean; selected?: string[]; detail: string; }
interface Metric { value: number; numerator: number; denominator: number; }

export interface QualityEvaluation {
  dataset: string;
  rounds: number;
  totals: { capture: number; retrieval: number; all: number; required: number; challenge: number };
  passRates: { required: Metric; all: Metric; challenge: Metric };
  categoryPassRates: Record<string, Metric>;
  security: { leakageRate: Metric; leakedCaseIds: string[]; checkedCases: number };
  quality: { falseInjectionRate: Metric; missRate: Metric };
  latencyMs: { p50: number; p95: number; max: number };
  thresholds: QualityThresholds;
  passed: boolean;
  failures: QualityCaseResult[];
  requiredFailures: QualityCaseResult[];
  challengeFailures: QualityCaseResult[];
  samples: { capture: QualityCaseResult[]; retrieval: QualityCaseResult[] };
}

function metric(numerator: number, denominator: number): Metric {
  return { value: denominator === 0 ? 0 : Number((numerator / denominator).toFixed(4)), numerator, denominator };
}

function percentile(values: number[], percentileValue: number): number {
  if (!values.length) return 0;
  const sorted = [...values].sort((left, right) => left - right);
  const index = Math.min(sorted.length - 1, Math.ceil((percentileValue / 100) * sorted.length) - 1);
  return Number(sorted[Math.max(0, index)]!.toFixed(3));
}

function sameCandidate(actual: { kind: MemoryKind; value: string }, expected: QualityCaptureExpected): boolean {
  return actual.kind === expected.kind && actual.value === expected.value;
}

function evaluateCapture(testCase: QualityCaptureCase, round: number): QualityCaseResult {
  const rawItem: ConversationItem = { id: `${testCase.id}-${round}`, type: testCase.type as ConversationItem["type"], text: testCase.text, rawType: "qualityDataset" };
  const sanitized = sanitizeConversationItem(rawItem);
  const candidates = extractMemoryCandidates({ threadId: `quality-thread-${round}`, turnId: testCase.id, quality: testCase.quality, item: sanitized.item, now: "2030-01-01T00:00:00.000Z" });
  const exactSet = candidates.length === testCase.expected.length && testCase.expected.every((expected) => candidates.some((candidate) => sameCandidate(candidate, expected)));
  const confidenceSafe = testCase.expected.every((expected) => expected.maxConfidence === undefined || candidates.filter((candidate) => sameCandidate(candidate, expected)).every((candidate) => candidate.confidence <= expected.maxConfidence!));
  const passed = exactSet && confidenceSafe;
  return { id: testCase.id, category: testCase.category, status: testCase.status, round, passed, detail: passed ? "expected capture candidates matched" : JSON.stringify({ candidates: candidates.map((candidate) => ({ kind: candidate.kind, value: candidate.value, confidence: candidate.confidence })), expected: testCase.expected }) };
}

function memoryValueLabel(value: unknown): string {
  return typeof value === "string" ? value : JSON.stringify(value);
}

async function evaluateRetrieval(testCase: QualityRetrievalCase, round: number, latencies: number[], leakedCaseIds: string[]): Promise<QualityCaseResult> {
  const root = mkdtempSync(join(tmpdir(), `open-continuity-quality-${round}-`));
  const databasePath = join(root, "memories.db");
  const store = new SqliteMemoryStore(databasePath);
  const service = new MemoryService(store, {}, { defaultTokenBudget: 4096, maxTokenBudget: 16384, maxMemories: testCase.limit ?? 8, requireUserConfirmed: true });
  const labelToKey = new Map<string, string>();
  try {
    for (const memory of testCase.memories ?? []) {
      await service.remember({ userId: "quality-user", agentId: "quality-seeder", key: memory.key, value: memory.value, kind: "user_preference", scope: "user", sensitivity: memory.sensitivity ?? "public", userConfirmed: memory.userConfirmed ?? true, idempotencyKey: `quality:${round}:${testCase.id}:${memory.label}`, metadata: { quality: true } });
      labelToKey.set(memory.label, memory.key);
    }
    for (const write of testCase.writes ?? []) {
      await service.remember({ userId: "quality-user", agentId: "quality-seeder", key: write.key, value: write.value, kind: "user_preference", scope: "user", sensitivity: write.sensitivity ?? "public", userConfirmed: write.userConfirmed ?? true, idempotencyKey: `quality:${round}:${testCase.id}:${write.idempotencyKey}`, expectedVersion: write.expectedVersion, writeMode: write.writeMode, metadata: { quality: true } });
      for (const previousLabel of [...labelToKey.keys()].filter((label) => labelToKey.get(label) === write.key)) labelToKey.delete(previousLabel);
      labelToKey.set(write.label, write.key);
    }
    const started = performance.now();
    const pack = await service.context({ userId: "quality-user", agentId: "quality-reader", query: testCase.query, includePrivate: false, purpose: "general", tokenBudget: 4096, maxMemories: testCase.limit ?? 8 });
    latencies.push(Number((performance.now() - started).toFixed(3)));
    const selected = pack.items.map((item) => [...labelToKey.entries()].find(([, key]) => key === item.key)?.[0]).filter((label): label is string => Boolean(label));
    const expected = testCase.expected;
    const missing = expected.relevant.filter((label) => !selected.includes(label));
    const unexpected = selected.filter((label) => !expected.relevant.includes(label));
    const forbiddenSelected = selected.filter((label) => expected.forbidden.includes(label));
    if (forbiddenSelected.length && testCase.category === "security_boundary") leakedCaseIds.push(`${testCase.id}@${round}`);
    const orderMatches = expected.ordered === undefined || JSON.stringify(selected.slice(0, expected.ordered.length)) === JSON.stringify(expected.ordered);
    const valuesMatch = (expected.values ?? []).every((expectedValue) => {
      const key = labelToKey.get(expectedValue.label);
      const item = pack.items.find((candidate) => candidate.key === key);
      return Boolean(item) && isDeepStrictEqual(item!.value, expectedValue.value) && (expectedValue.version === undefined || item!.version === expectedValue.version);
    });
    const passed = missing.length === 0 && unexpected.length === 0 && forbiddenSelected.length === 0 && orderMatches && valuesMatch;
    return { id: testCase.id, category: testCase.category, status: testCase.status, round, passed, selected, detail: passed ? "expected retrieval selection and evolution state matched" : JSON.stringify({ selected, expected, missing, unexpected, forbiddenSelected, orderMatches, valuesMatch, items: pack.items.map((item) => ({ key: item.key, value: memoryValueLabel(item.value), version: item.version })) }) };
  } catch (error) {
    return { id: testCase.id, category: testCase.category, status: testCase.status, round, passed: false, detail: error instanceof Error ? error.message : String(error) };
  } finally {
    await service.close();
    rmSync(root, { recursive: true, force: true });
  }
}

export async function evaluateQuality(dataset: QualityDataset): Promise<QualityEvaluation> {
  const captureResults: QualityCaseResult[] = [];
  const retrievalResults: QualityCaseResult[] = [];
  const latencies: number[] = [];
  const leakedCaseIds: string[] = [];
  let relevantTotal = 0;
  let missedRelevant = 0;
  let unexpectedTotal = 0;
  let falseInjectionTotal = 0;
  for (let round = 1; round <= dataset.rounds; round += 1) {
    captureResults.push(...dataset.capture.map((testCase) => evaluateCapture(testCase, round)));
    for (const testCase of dataset.retrieval) retrievalResults.push(await evaluateRetrieval(testCase, round, latencies, leakedCaseIds));
  }
  const allResults = [...captureResults, ...retrievalResults];
  const requiredResults = allResults.filter((result) => result.status === "required");
  const challengeResults = allResults.filter((result) => result.status === "challenge");
  const categoryNames = [...new Set(allResults.map((result) => result.category))];
  const categoryPassRates = Object.fromEntries(categoryNames.map((category) => {
    const results = allResults.filter((result) => result.category === category);
    return [category, metric(results.filter((result) => result.passed).length, results.length)];
  }));
  const securityCaseCount = dataset.retrieval.filter((testCase) => testCase.category === "security_boundary").length * dataset.rounds;
  for (const result of retrievalResults) {
    if (!result.selected) continue;
    const testCase = dataset.retrieval.find((candidate) => candidate.id === result.id)!;
    relevantTotal += testCase.expected.relevant.length;
    missedRelevant += testCase.expected.relevant.filter((label) => !result.selected!.includes(label)).length;
    unexpectedTotal += result.selected.filter((label) => !testCase.expected.relevant.includes(label)).length;
    falseInjectionTotal += result.selected.filter((label) => !testCase.expected.relevant.includes(label) && !testCase.expected.forbidden.includes(label)).length;
  }
  const result: QualityEvaluation = {
    dataset: dataset.version, rounds: dataset.rounds,
    totals: { capture: captureResults.length, retrieval: retrievalResults.length, all: allResults.length, required: requiredResults.length, challenge: challengeResults.length },
    passRates: { required: metric(requiredResults.filter((item) => item.passed).length, requiredResults.length), all: metric(allResults.filter((item) => item.passed).length, allResults.length), challenge: metric(challengeResults.filter((item) => item.passed).length, challengeResults.length) },
    categoryPassRates,
    security: { leakageRate: metric(leakedCaseIds.length, securityCaseCount), leakedCaseIds: [...new Set(leakedCaseIds)], checkedCases: securityCaseCount },
    quality: { falseInjectionRate: metric(falseInjectionTotal, unexpectedTotal), missRate: metric(missedRelevant, relevantTotal) },
    latencyMs: { p50: percentile(latencies, 50), p95: percentile(latencies, 95), max: Number(Math.max(...latencies, 0).toFixed(3)) },
    thresholds: dataset.thresholds, passed: false, failures: allResults.filter((item) => !item.passed), requiredFailures: requiredResults.filter((item) => !item.passed), challengeFailures: challengeResults.filter((item) => !item.passed), samples: { capture: captureResults, retrieval: retrievalResults },
  };
  result.passed = result.passRates.required.value >= dataset.thresholds.requiredCasePassRate && result.security.leakageRate.value <= dataset.thresholds.securityLeakageRate;
  return result;
}

export function loadQualityDataset(path: string): QualityDataset {
  return JSON.parse(readFileSync(path, "utf8")) as QualityDataset;
}
