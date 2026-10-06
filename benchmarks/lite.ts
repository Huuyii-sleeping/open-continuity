import { mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import { MemoryService } from "../src/core/memory-service.js";
import { SqliteMemoryStore } from "../src/sqlite/sqlite-memory-store.js";

interface BenchmarkSample { operation: string; iterations: number; p50Ms: number; p95Ms: number; maxMs: number; }

function integerOption(name: string, fallback: number): number {
  const argument = process.argv.find((value) => value.startsWith(`--${name}=`));
  const value = Number(argument?.slice(name.length + 3) ?? fallback);
  if (!Number.isInteger(value) || value <= 0) throw new Error(`--${name} must be a positive integer`);
  return value;
}

function percentile(sorted: number[], fraction: number): number {
  return sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * fraction) - 1)] ?? 0;
}

function rounded(value: number): number { return Number(value.toFixed(3)); }

async function measure(operation: string, iterations: number, action: (iteration: number) => Promise<unknown>): Promise<BenchmarkSample> {
  const durations: number[] = [];
  for (let iteration = 0; iteration < iterations; iteration += 1) {
    const startedAt = performance.now();
    await action(iteration);
    durations.push(performance.now() - startedAt);
  }
  durations.sort((left, right) => left - right);
  return { operation, iterations, p50Ms: rounded(percentile(durations, 0.5)), p95Ms: rounded(percentile(durations, 0.95)), maxMs: rounded(durations.at(-1) ?? 0) };
}

const memories = integerOption("memories", 10_000);
const iterations = integerOption("iterations", 100);
const directory = mkdtempSync(join(tmpdir(), "open-continuity-benchmark-"));
const databasePath = join(directory, "memories.db");
const service = new MemoryService(new SqliteMemoryStore(databasePath));

try {
  const seedStartedAt = performance.now();
  for (let index = 0; index < memories; index += 1) {
    await service.remember({
      userId: "benchmark-user",
      agentId: `benchmark-agent-${index % 4}`,
      key: `fictional_preference_${index}`,
      value: `Fictional benchmark topic-${index % 250} record ${index}`,
      kind: index % 5 === 0 ? "decision" : "user_preference",
      userConfirmed: index % 3 === 0,
      idempotencyKey: `benchmark-${index}`,
    });
  }
  const seedMs = performance.now() - seedStartedAt;

  const samples = [
    await measure("exact-key recall", iterations, async (iteration) => service.recall({
      userId: "benchmark-user", agentId: "benchmark-reader", key: `fictional_preference_${iteration % memories}`, limit: 1,
    })),
    await measure("FTS recall", iterations, async (iteration) => service.recall({
      userId: "benchmark-user", agentId: "benchmark-reader", query: `topic-${iteration % 250}`, limit: 10,
    })),
    await measure("Context Pack", iterations, async (iteration) => service.context({
      userId: "benchmark-user", agentId: "benchmark-reader", query: `topic-${iteration % 250}`, purpose: "general", tokenBudget: 1024, maxMemories: 10,
    })),
  ];

  process.stdout.write(JSON.stringify({
    format: "open-continuity-lite-benchmark-v1",
    environment: { platform: process.platform, architecture: process.arch, node: process.version },
    dataset: { memories, events: memories, databaseBytes: statSync(databasePath).size },
    seed: { totalMs: rounded(seedMs), writesPerSecond: rounded(memories / (seedMs / 1000)) },
    samples,
    note: "Local synthetic benchmark; results are not a cross-machine performance guarantee.",
  }, null, 2) + "\n");
} finally {
  await service.close();
  rmSync(directory, { recursive: true, force: true });
}
