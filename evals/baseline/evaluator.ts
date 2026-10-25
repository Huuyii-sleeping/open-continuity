import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { cpus, tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { performance } from "node:perf_hooks";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath, pathToFileURL } from "node:url";
import { isDeepStrictEqual } from "node:util";
import { DataType, newDb } from "pg-mem";
import type { MemoryService } from "../../src/core/memory-service.js";
import type { DatabasePool } from "../../src/postgres/postgres-memory-store.js";
import { loadDataset, type BaselineCase } from "./dataset.js";
import { latencySummary, mean, ratio, scoreRanking } from "./metrics.js";

export const BACKENDS = ["sqlite", "inmemory", "json", "postgres-pg-mem"] as const;
export type Backend = typeof BACKENDS[number];
const USER = "baseline-fictional-user";
const AGENT = "baseline-fictional-reader";
export const SETTINGS = { rounds: 3, repeatQueries: 3, warmupQueries: 1, candidateLimit: 50, tokenBudget: 4096, writeSpacingMs: 2 };
export const hash = (value: string | Buffer) => createHash("sha256").update(value).digest("hex");

function files(root: string): string[] {
  return readdirSync(root, { withFileTypes: true }).flatMap((entry) => entry.isDirectory() ? files(join(root, entry.name)) : entry.isFile() ? [join(root, entry.name)] : []).sort();
}
function treeHash(root: string, paths: string[]) {
  return hash(paths.sort().map((path) => `${relative(root, path)}:${hash(readFileSync(path))}`).join("\n"));
}
export function sourceEvidence(root: string) {
  const commit = execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim();
  return { commit, sourceHash: treeHash(root, files(join(root, "src"))), lockHash: hash(readFileSync(join(root, "package-lock.json"))),
    trackedChanges: execFileSync("git", ["diff", "HEAD", "--name-only", "--", "src", "package-lock.json"], { cwd: root, encoding: "utf8" }).trim().split("\n").filter(Boolean) };
}

export async function runtime(sourceRoot: string, backend: Backend) {
  const directory = mkdtempSync(join(tmpdir(), "open-continuity-core-baseline-"));
  let pool: DatabasePool | undefined;
  let service: MemoryService | undefined;
  const moduleAt = (path: string) => import(pathToFileURL(join(sourceRoot, path)).href);
  try {
    const { MemoryService: Service } = await moduleAt("src/core/memory-service.ts") as typeof import("../../src/core/memory-service.js");
    let store: ConstructorParameters<typeof Service>[0];
    if (backend === "sqlite") {
      const { SqliteMemoryStore } = await moduleAt("src/sqlite/sqlite-memory-store.ts") as typeof import("../../src/sqlite/sqlite-memory-store.js");
      store = new SqliteMemoryStore(join(directory, "fictional.db"));
    } else if (backend === "postgres-pg-mem") {
      const { PostgresMemoryStore } = await moduleAt("src/postgres/postgres-memory-store.ts") as typeof import("../../src/postgres/postgres-memory-store.js");
      const database = newDb({ autoCreateForeignKeyIndices: true });
      database.public.registerFunction({ name: "pg_advisory_xact_lock", args: [DataType.integer], returns: DataType.integer, implementation: () => 1 });
      database.public.registerFunction({ name: "strpos", args: [DataType.text, DataType.text], returns: DataType.integer, implementation: (text: string, part: string) => text.indexOf(part) + 1 });
      const adapter = database.adapters.createPg();
      pool = new adapter.Pool();
      store = new PostgresMemoryStore(pool!);
    } else {
      const { InMemoryStore, JsonFileStore } = await moduleAt("src/core/memory-store.ts") as typeof import("../../src/core/memory-store.js");
      store = backend === "json" ? new JsonFileStore(join(directory, "fictional.json")) : new InMemoryStore();
    }
    service = new Service(store, { candidateLimit: SETTINGS.candidateLimit }, {
      defaultTokenBudget: SETTINGS.tokenBudget, maxTokenBudget: SETTINGS.tokenBudget, maxMemories: 20, requireUserConfirmed: true,
    });
    return { service, databasePath: join(directory, "fictional.db"), close: async () => {
      try { await service!.close(); } finally { try { await pool?.end?.(); } finally { rmSync(directory, { recursive: true, force: true }); } }
    } };
  } catch (error) {
    try { await service?.close(); } finally { try { await pool?.end?.(); } finally { rmSync(directory, { recursive: true, force: true }); } }
    throw error;
  }
}

type Ranking = ReturnType<typeof scoreRanking>;
export interface BaselineRow {
  backend: Backend; id: string; category: string; status: "required" | "challenge"; round: number; endpoint: "recall" | "context";
  selected: string[]; ranking: Ranking; passed: boolean; stable: boolean; valuesMatch: boolean;
  leakage: Record<string, ReturnType<typeof ratio>>; latency: ReturnType<typeof latencySummary>; error: string | null;
}
function boundaryLabels(testCase: BaselineCase, endpoint: "recall" | "context") {
  const result: Record<string, string[]> = { user: [], agent: [], task: [], private: [], userConfirmed: [] };
  for (const spec of [...testCase.memories ?? [], ...testCase.writes ?? []]) {
    if (spec.userId && spec.userId !== USER) result.user!.push(spec.label);
    if (spec.scope === "agent" && (spec.agentId ?? "baseline-fictional-seeder") !== AGENT) result.agent!.push(spec.label);
    if (spec.scope === "task" && spec.taskId !== testCase.taskId) result.task!.push(spec.label);
    if (spec.sensitivity === "private") result.private!.push(spec.label);
    if (endpoint === "context" && spec.userConfirmed === false) result.userConfirmed!.push(spec.label);
  }
  return result;
}

async function measureCase(sourceRoot: string, backend: Backend, testCase: BaselineCase, round: number, ks: number[]): Promise<BaselineRow[]> {
  const rows: BaselineRow[] = [];
  const rt = await runtime(sourceRoot, backend);
  const labels = new Map<string, string>();
  let seedError: string | null = null;
  try {
    try {
      for (const spec of [...testCase.memories ?? [], ...testCase.writes ?? []]) {
        const receipt = await rt.service.remember({
          userId: spec.userId ?? USER, agentId: spec.agentId ?? "baseline-fictional-seeder", key: spec.key, value: spec.value,
          kind: "user_preference", scope: spec.scope ?? "user", taskId: spec.taskId, sensitivity: spec.sensitivity ?? "public",
          userConfirmed: spec.userConfirmed ?? true, idempotencyKey: `baseline:${testCase.id}:${spec.idempotencyKey ?? spec.label}`,
          expectedVersion: spec.expectedVersion, writeMode: spec.writeMode, metadata: { fictional: true },
        });
        labels.set(receipt.current.id, spec.label);
        // Make temporal order explicit; random UUID ties must not decide ground truth.
        await delay(SETTINGS.writeSpacingMs);
      }
    } catch (error) { seedError = error instanceof Error ? error.name : "seed_error"; }
    for (const endpoint of ["recall", "context"] as const) {
      const expected = endpoint === "recall" ? testCase.recallExpected ?? testCase.expected : testCase.expected;
      const input = { userId: USER, agentId: AGENT, query: testCase.query, scope: testCase.scope, taskId: testCase.taskId, includePrivate: false };
      const request = async () => endpoint === "recall"
        ? (await rt.service.recall({ ...input, limit: Math.max(...ks) })).memories
        : (await rt.service.context({ ...input, purpose: "general", tokenBudget: SETTINGS.tokenBudget, maxMemories: testCase.limit ?? 8 })).items.map((item) => ({ ...item, id: item.memoryId }));
      let selected: string[] = [];
      let first: Array<{ id: string; value: unknown; version: number }> = [];
      let stable = true;
      let error = seedError;
      const samples: number[] = [];
      try {
        if (seedError) throw new Error("seed_failed");
        await request(); // Unmeasured warmup; no seed/setup latency in query statistics.
        for (let repeat = 0; repeat < SETTINGS.repeatQueries; repeat++) {
          const start = performance.now();
          const memories = await request();
          samples.push(performance.now() - start);
          // Never drop an unknown result: it is a false selection, not an empty hit.
          const observed = memories.map((item) => labels.get(item.id) ?? `unknown:${item.id}`);
          if (repeat === 0) { selected = observed; first = memories; }
          else if (!isDeepStrictEqual(selected, observed)) stable = false;
        }
      } catch (failure) { error ??= failure instanceof Error ? failure.name : "query_error"; stable = false; }
      const ranking = scoreRanking(selected, expected, ks, testCase.grades);
      const valuesMatch = (expected.values ?? []).every((value) => {
        const index = selected.indexOf(value.label);
        const item = first[index];
        return item !== undefined && isDeepStrictEqual(item.value, value.value) && (value.version === undefined || item.version === value.version);
      });
      const orderMatches = !expected.ordered || isDeepStrictEqual(selected.slice(0, expected.ordered.length), expected.ordered);
      const leakage = Object.fromEntries(Object.entries(boundaryLabels(testCase, endpoint)).map(([boundary, forbidden]) => [boundary, ratio(new Set(selected.filter((label) => forbidden.includes(label))).size, new Set(forbidden).size)]));
      const passed = !error && ranking.miss.numerator === 0 && ranking.falseSelection.numerator === 0 && ranking.duplicates === 0 && valuesMatch && orderMatches;
      rows.push({ backend, id: testCase.id, category: testCase.category, status: endpoint === "recall" ? testCase.recallStatus ?? testCase.status : testCase.status, round, endpoint, selected, ranking, passed, stable, valuesMatch, leakage, latency: latencySummary(samples), error });
    }
  } finally { await rt.close(); }
  return rows;
}

function summarize(rows: BaselineRow[], ks: number[]) {
  const positive = rows.filter((row) => row.ranking.miss.denominator > 0);
  const required = rows.filter((row) => row.status === "required");
  return {
    cases: new Set(rows.map((row) => row.id)).size, observations: rows.length,
    requiredPass: ratio(required.filter((row) => row.passed).length, required.length),
    challengePass: ratio(rows.filter((row) => row.status === "challenge" && row.passed).length, rows.filter((row) => row.status === "challenge").length),
    atK: Object.fromEntries(ks.map((k) => [String(k), {
      recallMacro: mean(positive.map((row) => row.ranking.atK[String(k)]!.recall.value)),
      mrr: mean(positive.map((row) => row.ranking.atK[String(k)]!.reciprocalRank)),
      ndcg: mean(positive.map((row) => row.ranking.atK[String(k)]!.ndcg)),
    }])),
    missMicro: ratio(rows.reduce((sum, row) => sum + row.ranking.miss.numerator, 0), rows.reduce((sum, row) => sum + row.ranking.miss.denominator, 0)),
    falseSelectionMicro: ratio(rows.reduce((sum, row) => sum + row.ranking.falseSelection.numerator, 0), rows.reduce((sum, row) => sum + row.ranking.falseSelection.denominator, 0)),
    repeatStability: ratio(rows.filter((row) => row.stable).length, rows.length),
    rebuildStability: ratio([...new Set(rows.map((row) => row.id))].filter((id) => new Set(rows.filter((row) => row.id === id).map((row) => JSON.stringify(row.selected))).size === 1).length, new Set(rows.map((row) => row.id)).size),
    currentFactSelection: ratio(rows.filter((row) => ["evolution_conflict", "evolution_merge", "temporal_conflict"].includes(row.category) && row.passed).length, rows.filter((row) => ["evolution_conflict", "evolution_merge", "temporal_conflict"].includes(row.category)).length),
    leakage: Object.fromEntries(["user", "agent", "task", "private", "userConfirmed"].map((name) => [name, ratio(rows.reduce((sum, row) => sum + row.leakage[name]!.numerator, 0), rows.reduce((sum, row) => sum + row.leakage[name]!.denominator, 0))])),
    latency: latencySummary(rows.flatMap((row) => row.latency.samplesMs)),
  };
}

export async function evaluateBaseline(sourceRoot: string, datasetPath: string, backends: readonly Backend[] = BACKENDS) {
  const dataset = loadDataset(datasetPath);
  if (backends.length === 0 || new Set(backends).size !== backends.length) throw new Error("Specify unique backends");
  const harnessRoot = dirname(fileURLToPath(import.meta.url));
  const evidence = sourceEvidence(resolve(sourceRoot));
  const rows: BaselineRow[] = [];
  for (const backend of backends) for (let round = 1; round <= dataset.rounds; round++) for (const testCase of dataset.cases) {
    rows.push(...await measureCase(resolve(sourceRoot), backend, testCase, round, dataset.ks));
  }
  if (!isDeepStrictEqual(evidence, sourceEvidence(resolve(sourceRoot)))) throw new Error("Source changed during evaluation");
  const settings = { ...SETTINGS, rounds: dataset.rounds, ks: dataset.ks, backends: [...backends] };
  const comparable = { datasetHash: hash(readFileSync(datasetPath)), harnessHash: treeHash(harnessRoot, files(harnessRoot)), settings, sourceLockHash: evidence.lockHash, harnessLockHash: hash(readFileSync(join(harnessRoot, "../../package-lock.json"))), node: process.version };
  const requiredFailures = rows.filter((row) => row.status === "required" && !row.passed).map((row) => `${row.backend}/${row.endpoint}/${row.id}@${row.round}`);
  const errors = rows.filter((row) => row.error).map((row) => `${row.backend}/${row.endpoint}/${row.id}@${row.round}`);
  const leaks = rows.filter((row) => Object.values(row.leakage).some((value) => value.numerator > 0));
  const unstable = rows.filter((row) => !row.stable);
  const rebuildUnstable = [...new Set(rows.map((row) => `${row.backend}/${row.endpoint}/${row.id}`))].filter((key) => {
    const group = rows.filter((row) => `${row.backend}/${row.endpoint}/${row.id}` === key);
    return new Set(group.map((row) => JSON.stringify(row.selected))).size !== 1;
  });
  return {
    format: "open-continuity-core-baseline-report-v1" as const,
    evidence, comparable, environment: { platform: process.platform, architecture: process.arch, cpuModel: cpus()[0]?.model ?? "unknown", node: process.version },
    coverage: { distinctCases: dataset.cases.length, backends, endpoints: ["recall", "context"], postgres: "pg-mem emulation only; real PostgreSQL NOT VERIFIED", workspace: "NOT COVERED: enforced by Adapter/Injection boundary", answer: "NOT IMPLEMENTED", sameTimestampTieRebuild: "NOT COVERED", performance: "small fixtures; use benchmark:lite for capacity" },
    summary: Object.fromEntries(backends.flatMap((backend) => ["recall", "context"].map((endpoint) => [`${backend}/${endpoint}`, summarize(rows.filter((row) => row.backend === backend && row.endpoint === endpoint), dataset.ks)]))),
    gate: { passed: requiredFailures.length === 0 && errors.length === 0 && leaks.length === 0 && unstable.length === 0 && rebuildUnstable.length === 0, requiredFailures, errors, leakageObservations: leaks.length, unstableObservations: unstable.length, rebuildUnstable },
    rows,
  };
}
export type BaselineReport = Awaited<ReturnType<typeof evaluateBaseline>>;
