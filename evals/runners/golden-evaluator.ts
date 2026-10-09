import { readFileSync } from "node:fs";
import { mkdtempSync, readFileSync as readText, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import { extractMemoryCandidates } from "../../src/capture/candidate-extractor.js";
import { sanitizeConversationItem } from "../../src/capture/sensitivity.js";
import type { CaptureQuality, ConversationItem } from "../../src/capture/types.js";
import { defaultConfig, saveConfig } from "../../src/cli/config.js";
import { MemoryService } from "../../src/core/memory-service.js";
import { runInjectionHook } from "../../src/injection/injection-service.js";
import { SqliteMemoryStore } from "../../src/sqlite/sqlite-memory-store.js";
import type { MemoryKind, Sensitivity } from "../../src/shared/types.js";

export interface GoldenDataset {
  version: string;
  description: string;
  capture: CaptureCase[];
  injection: InjectionCase[];
}

interface CaptureCase {
  id: string; text: string; quality: CaptureQuality; sensitive?: boolean;
  expected: { kind: MemoryKind; value: string; maxConfidence?: number } | null;
}

interface InjectionMemory {
  label: string; key: string; value: string; sensitivity: Sensitivity; userConfirmed: boolean;
}

interface InjectionCase {
  id: string; prompt: string; workspaceAllowed: boolean; memories: InjectionMemory[];
  expected: { relevant: string[]; forbidden: string[] };
}

interface Metric { value: number; numerator: number; denominator: number; }

export interface GoldenEvaluation {
  dataset: string;
  capture: {
    cases: number;
    candidatePrecision: Metric;
    candidateRecall: Metric;
    recallAt1: Metric;
    sensitiveBlockRate: Metric;
    results: Array<{ id: string; predicted: Array<{ kind: MemoryKind; value: string; confidence: number }>; expected: CaptureCase["expected"] | null; sensitive: boolean }>;
  };
  injection: {
    cases: number;
    precisionAtK: Metric;
    recallAtK: Metric;
    falseInjectionRate: Metric;
    missRate: Metric;
    securityLeakageRate: Metric;
    latencyMs: { p50: number; p95: number; max: number };
    results: Array<{ id: string; selected: string[]; relevant: string[]; forbidden: string[]; latencyMs: number; injected: boolean }>;
  };
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

function sameCandidate(actual: { kind: MemoryKind; value: string }, expected: NonNullable<CaptureCase["expected"]>): boolean {
  return actual.kind === expected.kind && actual.value === expected.value;
}

function evaluateCapture(dataset: GoldenDataset): GoldenEvaluation["capture"] {
  let predictedPositive = 0;
  let matched = 0;
  let expectedPositive = 0;
  let sensitiveCases = 0;
  let sensitiveBlocked = 0;
  const results = dataset.capture.map((testCase) => {
    const rawItem: ConversationItem = { id: testCase.id, type: "user_message", text: testCase.text, rawType: "goldenDataset" };
    const sanitized = sanitizeConversationItem(rawItem);
    const candidates = extractMemoryCandidates({ threadId: "golden-thread", turnId: testCase.id, quality: testCase.quality, item: sanitized.item, now: "2030-01-01T00:00:00.000Z" });
    const predicted = candidates.map((candidate) => ({ kind: candidate.kind, value: candidate.value, confidence: candidate.confidence }));
    const expected = testCase.expected;
    if (expected) expectedPositive += 1;
    if (predicted.length) predictedPositive += 1;
    if (expected && candidates.some((candidate) => sameCandidate(candidate, expected))) matched += 1;
    if (testCase.sensitive) {
      sensitiveCases += 1;
      if (!candidates.length && sanitized.matches.length > 0 && !JSON.stringify(sanitized.item).includes(testCase.text)) sensitiveBlocked += 1;
    }
    if (expected?.maxConfidence !== undefined) {
      const maxConfidence = expected.maxConfidence;
      if (candidates.some((candidate) => candidate.confidence > maxConfidence)) throw new Error(`Capture confidence gate failed for ${testCase.id}`);
    }
    return { id: testCase.id, predicted, expected, sensitive: testCase.sensitive ?? false };
  });
  return {
    cases: dataset.capture.length,
    candidatePrecision: metric(matched, predictedPositive),
    candidateRecall: metric(matched, expectedPositive),
    recallAt1: metric(dataset.capture.filter((testCase) => {
      const result = results.find((entry) => entry.id === testCase.id)!;
      return testCase.expected !== null && result.predicted.slice(0, 1).some((candidate) => sameCandidate(candidate, testCase.expected!));
    }).length, expectedPositive),
    sensitiveBlockRate: metric(sensitiveBlocked, sensitiveCases),
    results,
  };
}

async function evaluateInjection(dataset: GoldenDataset): Promise<GoldenEvaluation["injection"]> {
  let truePositive = 0;
  let falsePositive = 0;
  let falseNegative = 0;
  let forbiddenSelected = 0;
  let forbiddenTotal = 0;
  const latencies: number[] = [];
  const results: GoldenEvaluation["injection"]["results"] = [];

  for (const testCase of dataset.injection) {
    const root = mkdtempSync(join(tmpdir(), "open-continuity-golden-"));
    const workspace = join(root, "fictional-workspace");
    const outsideWorkspace = join(root, "outside-workspace");
    const env = { ...process.env, HOME: join(root, "home"), OPEN_CONTINUITY_HOME: join(root, "data") };
    const config = defaultConfig(env);
    config.injection = { ...config.injection, enabled: true, workspaces: [workspace], maxMemories: 8 };
    saveConfig(config, env);
    const labelsToIds = new Map<string, string>();
    const service = new MemoryService(new SqliteMemoryStore(config.databasePath));
    try {
      for (const memory of testCase.memories) {
        const receipt = await service.remember({
          userId: config.userId, agentId: "golden-seeder", key: memory.key, value: memory.value, kind: "user_preference", scope: "user",
          sensitivity: memory.sensitivity, userConfirmed: memory.userConfirmed, idempotencyKey: `golden:${testCase.id}:${memory.label}`, metadata: { golden: true },
        });
        labelsToIds.set(memory.label, receipt.current.id);
      }
    } finally {
      await service.close();
    }
    const started = performance.now();
    const output = await runInjectionHook({ prompt: testCase.prompt, cwd: testCase.workspaceAllowed ? workspace : outsideWorkspace, session_id: `golden-${testCase.id}` }, env);
    const latencyMs = Number((performance.now() - started).toFixed(3));
    latencies.push(latencyMs);
    const receiptLines = readText(join(env.OPEN_CONTINUITY_HOME!, "injection-receipts.jsonl"), "utf8").trim().split("\n");
    const receipt = JSON.parse(receiptLines.at(-1)!) as { memoryIds: string[]; outcome: string };
    const selected = [...labelsToIds.entries()].filter(([, memoryId]) => receipt.memoryIds.includes(memoryId)).map(([label]) => label);
    const relevant = testCase.expected.relevant;
    const forbidden = testCase.expected.forbidden;
    const selectedRelevant = selected.filter((label) => relevant.includes(label));
    const selectedForbidden = selected.filter((label) => forbidden.includes(label));
    truePositive += selectedRelevant.length;
    falsePositive += selected.filter((label) => !relevant.includes(label)).length;
    falseNegative += relevant.filter((label) => !selected.includes(label)).length;
    forbiddenSelected += selectedForbidden.length;
    forbiddenTotal += forbidden.length;
    results.push({ id: testCase.id, selected, relevant, forbidden, latencyMs, injected: receipt.outcome === "injected" && Boolean(output.hookSpecificOutput) });
    rmSync(root, { recursive: true, force: true });
  }
  return {
    cases: dataset.injection.length,
    precisionAtK: metric(truePositive, truePositive + falsePositive),
    recallAtK: metric(truePositive, truePositive + falseNegative),
    falseInjectionRate: metric(falsePositive, truePositive + falsePositive),
    missRate: metric(falseNegative, truePositive + falseNegative),
    securityLeakageRate: metric(forbiddenSelected, forbiddenTotal),
    latencyMs: { p50: percentile(latencies, 50), p95: percentile(latencies, 95), max: Number(Math.max(...latencies, 0).toFixed(3)) },
    results,
  };
}

export async function evaluateGoldenDataset(dataset: GoldenDataset): Promise<GoldenEvaluation> {
  return { dataset: dataset.version, capture: evaluateCapture(dataset), injection: await evaluateInjection(dataset) };
}

export function loadGoldenDataset(path: string): GoldenDataset {
  return JSON.parse(readFileSync(path, "utf8")) as GoldenDataset;
}
