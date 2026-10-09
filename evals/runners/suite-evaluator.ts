import { readFileSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { performance } from "node:perf_hooks";
import { extractMemoryCandidates } from "../../src/capture/candidate-extractor.js";
import { ConversationInbox } from "../../src/capture/conversation-inbox.js";
import { sanitizeConversationItem } from "../../src/capture/sensitivity.js";
import { syncTraeCapture } from "../../src/capture/trae-capture-service.js";
import { watchTraeCapture } from "../../src/capture/trae-watch.js";
import type { CaptureQuality, ConversationItem, ConversationThread } from "../../src/capture/types.js";
import { defaultConfig, saveConfig } from "../../src/cli/config.js";
import { MemoryService } from "../../src/core/memory-service.js";
import { runInjectionHook } from "../../src/injection/injection-service.js";
import { checkTraeInjectionHook, installTraeInjectionHook, traeHookConfigPath } from "../../src/injection/trae-hook-config.js";
import { SqliteMemoryStore } from "../../src/sqlite/sqlite-memory-store.js";
import type { MemoryKind, Sensitivity } from "../../src/shared/types.js";
import { installFakeTraeCli } from "../../test/helpers/fake-trae.js";

export interface SuiteDataset {
  version: string;
  description: string;
  rounds: number;
  thresholds: SuiteThresholds;
  capture: CaptureCase[];
  injection: InjectionCase[];
  governance: GovernanceCase[];
}

export interface SuiteThresholds {
  captureCasePassRate: number;
  injectionCasePassRate: number;
  governanceCasePassRate: number;
  securityLeakageRate: number;
  maxInjectionP95Ms: number;
}

interface CaptureExpected { kind: MemoryKind; value: string; maxConfidence?: number; }
interface CaptureCase { id: string; type: string; text: string; quality: CaptureQuality; sensitive?: boolean; expected: CaptureExpected[]; }
interface InjectionMemory { label: string; key: string; value: string; sensitivity: Sensitivity; userConfirmed: boolean; }
interface InjectionCase { id: string; prompt: string | null; workspaceAllowed: boolean; memories: InjectionMemory[]; expected: { relevant: string[]; forbidden: string[] }; }
interface GovernanceCase { id: string; }
interface CaseResult { id: string; round: number; passed: boolean; detail: string; }
interface Metric { value: number; numerator: number; denominator: number; }

export interface SuiteEvaluation {
  dataset: string;
  rounds: number;
  totals: { capture: number; injection: number; governance: number; all: number };
  passRates: { capture: Metric; injection: Metric; governance: Metric; all: Metric };
  security: { leakageRate: Metric; leakedCaseIds: string[] };
  latencyMs: { p50: number; p95: number; p99: number; max: number };
  thresholds: SuiteThresholds;
  passed: boolean;
  failures: CaseResult[];
  samples: { capture: CaseResult[]; injection: CaseResult[]; governance: CaseResult[] };
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

function sameCandidate(actual: { kind: MemoryKind; value: string }, expected: CaptureExpected): boolean {
  return actual.kind === expected.kind && actual.value === expected.value;
}

function evaluateCaptureCase(testCase: CaptureCase, round: number): CaseResult {
  const rawItem: ConversationItem = { id: `${testCase.id}-${round}`, type: testCase.type as ConversationItem["type"], text: testCase.text, rawType: "suiteDataset" };
  const sanitized = sanitizeConversationItem(rawItem);
  const candidates = extractMemoryCandidates({ threadId: `suite-thread-${round}`, turnId: testCase.id, quality: testCase.quality, item: sanitized.item, now: "2030-01-01T00:00:00.000Z" });
  const matches = testCase.expected.every((expected) => candidates.some((candidate) => sameCandidate(candidate, expected))) && candidates.length === testCase.expected.length;
  const confidenceSafe = testCase.expected.every((expected) => expected.maxConfidence === undefined || candidates.filter((candidate) => sameCandidate(candidate, expected)).every((candidate) => candidate.confidence <= expected.maxConfidence!));
  const sensitiveSafe = !testCase.sensitive || (sanitized.matches.length > 0 && candidates.length === 0 && !JSON.stringify(sanitized.item).includes(testCase.text));
  const passed = matches && confidenceSafe && sensitiveSafe;
  return { id: testCase.id, round, passed, detail: passed ? "expected candidates and safety gates matched" : JSON.stringify({ candidates: candidates.map((candidate) => ({ kind: candidate.kind, value: candidate.value, confidence: candidate.confidence })), expected: testCase.expected, sensitiveMatches: sanitized.matches.length }) };
}

async function evaluateInjectionCase(testCase: InjectionCase, round: number, latencies: number[], leakedCaseIds: string[]): Promise<CaseResult> {
  const root = mkdtempSync(join(tmpdir(), `open-continuity-suite-injection-${round}-`));
  try {
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
        const receipt = await service.remember({ userId: config.userId, agentId: "suite-seeder", key: memory.key, value: memory.value, kind: "user_preference", scope: "user", sensitivity: memory.sensitivity, userConfirmed: memory.userConfirmed, idempotencyKey: `suite:${round}:${testCase.id}:${memory.label}`, metadata: { suite: true } });
        labelsToIds.set(memory.label, receipt.current.id);
      }
    } finally { await service.close(); }
    const started = performance.now();
    const output = await runInjectionHook({ ...(testCase.prompt === null ? {} : { prompt: testCase.prompt }), cwd: testCase.workspaceAllowed ? workspace : outsideWorkspace, session_id: `suite-${round}-${testCase.id}` }, env);
    const latencyMs = Number((performance.now() - started).toFixed(3));
    latencies.push(latencyMs);
    const receiptPath = join(env.OPEN_CONTINUITY_HOME!, "injection-receipts.jsonl");
    const receiptLines = readFileSync(receiptPath, "utf8").trim().split("\n");
    const receipt = JSON.parse(receiptLines.at(-1)!) as { memoryIds: string[]; outcome: string };
    const selected = [...labelsToIds.entries()].filter(([, memoryId]) => receipt.memoryIds.includes(memoryId)).map(([label]) => label);
    const expected = testCase.expected;
    const missing = expected.relevant.filter((label) => !selected.includes(label));
    const unexpected = selected.filter((label) => !expected.relevant.includes(label));
    const forbiddenSelected = selected.filter((label) => expected.forbidden.includes(label));
    if (forbiddenSelected.length) leakedCaseIds.push(`${testCase.id}@${round}`);
    const expectedInjected = expected.relevant.length > 0;
    const actualInjected = receipt.outcome === "injected" && Boolean(output.hookSpecificOutput);
    const passed = missing.length === 0 && unexpected.length === 0 && forbiddenSelected.length === 0 && actualInjected === expectedInjected;
    return { id: testCase.id, round, passed, detail: passed ? "expected selection and safety gates matched" : JSON.stringify({ selected, expected, outcome: receipt.outcome, hasContext: Boolean(output.hookSpecificOutput), missing, unexpected, forbiddenSelected }) };
  } finally { rmSync(root, { recursive: true, force: true }); }
}

function fictionalThread(id: string, updatedAt: string): ConversationThread {
  return { source: "trae", id, sessionId: `session-${id}`, cwd: "/tmp/fictional-suite", cliVersion: "9.9.9-fictional", ephemeral: false, createdAt: "2030-01-01T00:00:00.000Z", updatedAt, preview: "fictional suite thread", turns: [{ id: `turn-${id}`, status: "completed", quality: "complete", items: [{ id: `item-${id}`, type: "user_message", text: "请记住虚构套件偏好", rawType: "suite" }, { id: `final-${id}`, type: "assistant_message", phase: "final_answer", text: "收到。", rawType: "suite" }] }] };
}

async function evaluateGovernanceCase(testCase: GovernanceCase, round: number): Promise<CaseResult> {
  const root = mkdtempSync(join(tmpdir(), `open-continuity-suite-governance-${round}-`));
  try {
    const detail: Record<string, unknown> = {};
    if (testCase.id === "inbox-idempotency") {
      const inbox = new ConversationInbox(join(root, "capture.db"));
      const thread = fictionalThread("idempotent", "2030-01-01T00:01:00.000Z");
      const first = inbox.importThreads([thread]); const second = inbox.importThreads([thread]); inbox.close();
      detail.pass = first.itemsImported === 2 && first.candidatesCreated === 1 && second.itemsImported === 0 && second.candidatesCreated === 0;
    } else if (testCase.id === "retention-pending-protection") {
      const inbox = new ConversationInbox(join(root, "capture.db"));
      const thread = fictionalThread("retained", "2030-01-01T00:00:00.000Z");
      inbox.importThreads([thread]);
      const pending = inbox.listCandidates()[0]!;
      const kept = inbox.cleanupExpired(7, Date.parse("2030-02-01T00:00:00.000Z"));
      inbox.rejectCandidate(pending.id);
      const cleaned = inbox.cleanupExpired(7, Date.parse("2030-02-01T00:00:00.000Z")); inbox.close();
      detail.pass = kept.threadsDeleted === 0 && cleaned.threadsDeleted === 1;
    } else if (testCase.id === "hook-install-idempotency") {
      const env = { ...process.env, HOME: join(root, "home"), OPEN_CONTINUITY_HOME: join(root, "data"), TRAECLI_HOME: join(root, "trae-cli") };
      const hookPath = join(root, "injection-hook.js"); writeFileSync(hookPath, "// fictional hook");
      const first = installTraeInjectionHook(env, process.execPath, hookPath); const second = installTraeInjectionHook(env, process.execPath, hookPath);
      detail.pass = first.changed && !second.changed && checkTraeInjectionHook(env, process.execPath, hookPath).installed;
    } else if (testCase.id === "hook-existing-config-backup") {
      const env = { ...process.env, HOME: join(root, "home"), OPEN_CONTINUITY_HOME: join(root, "data"), TRAECLI_HOME: join(root, "trae-cli") };
      mkdirSync(join(root, "trae-cli"), { recursive: true });
      const path = traeHookConfigPath(env); const existing = { hooks: { UserPromptSubmit: [{ matcher: "fictional", hooks: [{ type: "command", command: "fictional-existing" }] }] } }; writeFileSync(path, JSON.stringify(existing));
      const result = installTraeInjectionHook(env, process.execPath, join(root, "injection-hook.js"));
      detail.pass = Boolean(result.backupPath && existsSync(result.backupPath)) && JSON.parse(readFileSync(path, "utf8")).hooks.UserPromptSubmit.length === 2;
    } else if (testCase.id === "watch-incremental-abort") {
      const bin = installFakeTraeCli(root); const env = { ...process.env, HOME: join(root, "home"), OPEN_CONTINUITY_HOME: join(root, "data"), PATH: `${bin}${delimiter}${process.env.PATH || ""}` };
      const controller = new AbortController(); const cycles: Array<{ imported: number; skipped: number }> = [];
      const result = await watchTraeCapture({ limit: 10, intervalMs: 20, onCycle: (cycle) => { cycles.push({ imported: cycle.threadsImported, skipped: cycle.skippedUnchanged ?? 0 }); if (cycles.length === 2) controller.abort(); } }, env, controller.signal);
      detail.pass = result.cycles === 2 && cycles[0]?.imported === 1 && cycles[1]?.skipped === 1;
    } else if (testCase.id === "failure-fail-open") {
      const env = { ...process.env, HOME: join(root, "home"), OPEN_CONTINUITY_HOME: join(root, "data") }; const config = defaultConfig(env); config.injection = { ...config.injection, enabled: true, workspaces: [join(root, "workspace")], timeoutMs: 10 }; saveConfig(config, env);
      const timeout = await runInjectionHook({ prompt: "虚构故障测试", cwd: join(root, "workspace") }, env, { createService: () => ({ context: async () => { await new Promise((resolve) => setTimeout(resolve, 30)); return { context: "late", items: [], omitted: [], budget: { requestedTokens: 64, usedTokens: 0, remainingTokens: 64, maxMemories: 1, estimation: "utf8_bytes_v1" } }; }, close: async () => undefined }) });
      detail.pass = timeout.continue === true && !timeout.hookSpecificOutput;
    }
    return { id: testCase.id, round, passed: detail.pass === true, detail: JSON.stringify(detail) };
  } finally { rmSync(root, { recursive: true, force: true }); }
}

export async function evaluateSuite(dataset: SuiteDataset): Promise<SuiteEvaluation> {
  const captureResults: CaseResult[] = []; const injectionResults: CaseResult[] = []; const governanceResults: CaseResult[] = []; const latencies: number[] = []; const leakedCaseIds: string[] = [];
  for (let round = 1; round <= dataset.rounds; round += 1) {
    captureResults.push(...dataset.capture.map((testCase) => evaluateCaptureCase(testCase, round)));
    for (const testCase of dataset.injection) injectionResults.push(await evaluateInjectionCase(testCase, round, latencies, leakedCaseIds));
    for (const testCase of dataset.governance) governanceResults.push(await evaluateGovernanceCase(testCase, round));
  }
  const allResults = [...captureResults, ...injectionResults, ...governanceResults];
  const capturePass = captureResults.filter((result) => result.passed).length; const injectionPass = injectionResults.filter((result) => result.passed).length; const governancePass = governanceResults.filter((result) => result.passed).length;
  const securityChecks = dataset.injection.reduce((count, testCase) => count + testCase.expected.forbidden.length, 0) * dataset.rounds;
  const result: SuiteEvaluation = {
    dataset: dataset.version, rounds: dataset.rounds,
    totals: { capture: captureResults.length, injection: injectionResults.length, governance: governanceResults.length, all: allResults.length },
    passRates: { capture: metric(capturePass, captureResults.length), injection: metric(injectionPass, injectionResults.length), governance: metric(governancePass, governanceResults.length), all: metric(allResults.filter((item) => item.passed).length, allResults.length) },
    security: { leakageRate: metric(leakedCaseIds.length, securityChecks), leakedCaseIds: [...new Set(leakedCaseIds)] },
    latencyMs: { p50: percentile(latencies, 50), p95: percentile(latencies, 95), p99: percentile(latencies, 99), max: Number(Math.max(...latencies, 0).toFixed(3)) },
    thresholds: dataset.thresholds, passed: false, failures: allResults.filter((result) => !result.passed), samples: { capture: captureResults, injection: injectionResults, governance: governanceResults },
  };
  result.passed = result.passRates.capture.value >= dataset.thresholds.captureCasePassRate && result.passRates.injection.value >= dataset.thresholds.injectionCasePassRate && result.passRates.governance.value >= dataset.thresholds.governanceCasePassRate && result.security.leakageRate.value <= dataset.thresholds.securityLeakageRate && result.latencyMs.p95 <= dataset.thresholds.maxInjectionP95Ms;
  return result;
}

export function loadSuiteDataset(path: string): SuiteDataset { return JSON.parse(readFileSync(path, "utf8")) as SuiteDataset; }
