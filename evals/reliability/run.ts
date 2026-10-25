import { createHash } from "node:crypto";
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { performance } from "node:perf_hooks";
import { parseArgs } from "node:util";
import { pathToFileURL } from "node:url";
import { compareReliability, latency, performanceRegression, validObservation, type ReliabilityObservation, type ReliabilityReport, type ReliabilityRow } from "./metrics.js";

function sourceHash(root: string): string {
  const hash = createHash("sha256");
  const files = (path: string): string[] => readdirSync(join(root, path), { withFileTypes: true }).flatMap(entry =>
    entry.isDirectory() ? files(`${path}/${entry.name}`) : [`${path}/${entry.name}`]);
  for (const file of [...files("src"), "package-lock.json"].sort()) hash.update(file).update(readFileSync(join(root, file)));
  return hash.digest("hex");
}
const actor = { userId: "fictional-capacity-user", agentId: "fictional-capacity-reader" };
try {
  const { values } = parseArgs({ options: {
    source: { type: "string", default: "." }, "report-dir": { type: "string" }, compare: { type: "string" },
    sizes: { type: "string", default: "1000,10000" }, rounds: { type: "string", default: "3" },
    samples: { type: "string", default: "100" }, concurrency: { type: "string", default: "1,4" },
    "record-repeats": { type: "string", default: "1,16" },
  }, strict: true });
  if (!values["report-dir"]) throw new Error("Explicit new report directory required");
  const settings = { sizes: values.sizes!.split(",").map(Number), rounds: Number(values.rounds), samples: Number(values.samples), warmups: 10,
    concurrency: values.concurrency!.split(",").map(Number), recordRepeats: values["record-repeats"]!.split(",").map(Number) };
  if (!settings.sizes.length || settings.sizes.some(n => !Number.isInteger(n) || n < 1 || n > 100000)
    || !Number.isInteger(settings.rounds) || settings.rounds < 1 || settings.rounds > 5
    || !Number.isInteger(settings.samples) || settings.samples < 10 || settings.samples > 1000
    || !settings.concurrency.length || settings.concurrency.some(n => !Number.isInteger(n) || n < 1 || n > 32)
    || !settings.recordRepeats.length || settings.recordRepeats.some(n => !Number.isInteger(n) || n < 1 || n > 16)
    || new Set(settings.recordRepeats).size !== settings.recordRepeats.length
    || new Set(settings.sizes).size !== settings.sizes.length || new Set(settings.concurrency).size !== settings.concurrency.length) throw new Error("Invalid bounded workload settings");
  const source = resolve(values.source!), root = resolve(values["report-dir"]);
  const evaluatorHash = createHash("sha256").update(readFileSync(new URL("./run.ts", import.meta.url))).update(readFileSync(new URL("./metrics.ts", import.meta.url))).digest("hex");
  const before = values.compare ? JSON.parse(readFileSync(resolve(values.compare), "utf8")) as ReliabilityReport : null;
  const module = await import(pathToFileURL(join(source, "src/core/memory-service.ts")).href) as typeof import("../../src/core/memory-service.js");
  const sqlite = await import(pathToFileURL(join(source, "src/sqlite/sqlite-memory-store.ts")).href) as typeof import("../../src/sqlite/sqlite-memory-store.js");
  const fingerprint = sourceHash(source); const rows: ReliabilityRow[] = [];
  mkdirSync(root, { mode: 0o700 }); // No overwrite of previous evidence.
  for (const size of settings.sizes) for (let round = 1; round <= settings.rounds; round++) for (const recordRepeats of settings.recordRepeats) {
    const temporary = mkdtempSync(join(tmpdir(), "open-continuity-capacity-"));
    const service = new module.MemoryService(new sqlite.SqliteMemoryStore(join(temporary, "fictional.db")), {},
      { defaultTokenBudget: 4096, maxTokenBudget: 4096, maxMemories: 2, requireUserConfirmed: true });
    try {
      for (let n = 0; n < size; n++) await service.remember({ ...actor, key: `fictional-noise-${n}`, value: "fictional unrelated filler ".repeat(8), kind: "decision", userConfirmed: true, idempotencyKey: `fictional-noise-${n}` });
      for (const topic of ["alpha", "beta"]) await service.remember({ ...actor, key: `fictional-${topic}`, value: `fictional ${topic} permitted only when offline; not permitted otherwise. `.repeat(recordRepeats), kind: "decision", userConfirmed: true, idempotencyKey: `fictional-${topic}` });
      for (const [index, extra] of [{ userId: "fictional-other" }, { agentId: "fictional-other", scope: "agent" as const },
        { scope: "task" as const, taskId: "fictional-other" }, { sensitivity: "private" as const }, { userConfirmed: false }].entries()) {
        await service.remember({ ...actor, userConfirmed: true, ...extra, key: `fictional-forbidden-${index}`, value: "fictional alpha beta", kind: "decision", idempotencyKey: `fictional-forbidden-${index}` });
      }
      for (const operation of ["recall", "context", "query"] as const) for (const offeredConcurrency of settings.concurrency) {
        const invoke = async (): Promise<ReliabilityObservation> => {
          if (operation === "recall") {
            const result = await service.recall({ ...actor, query: "alpha", limit: 100 });
            // Recall permits unconfirmed records; do not mislabel that as a leak.
            return { outcome: "completed", keys: result.memories.map(item => item.key) };
          }
          if (operation === "context") {
            const result = await service.context({ ...actor, query: "alpha" });
            return { outcome: "completed", keys: result.items.map(item => item.key), budget: { used: result.budget.usedTokens, requested: result.budget.requestedTokens } };
          }
          const result = await service.query({ ...actor, query: "alpha and beta", subqueries: ["alpha", "beta"] });
          return { outcome: "completed", keys: result.contextPack.items.map(item => item.key), budget: { used: result.contextPack.budget.usedTokens, requested: result.contextPack.budget.requestedTokens },
            coveredQueries: result.contextPack.coverage?.coveredQueries, answerStatus: result.answer?.status,
            items: result.contextPack.items.map(item => ({ memoryId: item.memoryId, version: item.version, sourceEventId: item.sourceEventId })),
            citations: result.answer?.citations.map(item => ({ memoryId: item.memoryId, version: item.version, sourceEventId: item.sourceEventId })) };
        };
        for (let n = 0; n < settings.warmups; n++) if (!validObservation(operation, await invoke())) throw new Error("Invalid warmup response");
        const row: ReliabilityRow = { size, round, recordRepeats, operation, offeredConcurrency, responses: 0, completed: 0, busy: 0, timeout: 0, failed: 0,
          invalid: 0, latency: latency([]), rssSnapshotMax: process.memoryUsage().rss, yieldLagMs: [], observations: [] };
        const samples: number[] = [];
        for (let n = 0; n < settings.samples; n += offeredConcurrency) {
          const scheduled = performance.now(); const yielded = new Promise<void>(resolve => setTimeout(() => { row.yieldLagMs.push(performance.now() - scheduled); resolve(); }, 0));
          await Promise.all(Array.from({ length: Math.min(offeredConcurrency, settings.samples - n) }, async () => {
            const start = performance.now();
            try { const observation = await invoke(); row.observations.push(observation); row.completed++; if (!validObservation(operation, observation)) row.invalid++; }
            catch (error) {
              const code = error && typeof error === "object" && "code" in error ? error.code : null;
              const outcome = code === "RUNTIME_BUSY" ? "busy" : code === "READ_TIMEOUT" ? "timeout" : "failed";
              row[outcome]++; row.observations.push({ outcome, keys: [] });
            } finally { row.responses++; samples.push(performance.now() - start); }
          }));
          await yielded; row.rssSnapshotMax = Math.max(row.rssSnapshotMax, process.memoryUsage().rss);
        }
        row.latency = latency(samples); rows.push(row);
      }
    } finally { await service.close(); rmSync(temporary, { recursive: true, force: true }); }
  }
  if (sourceHash(source) !== fingerprint) throw new Error("Source changed while measuring");
  const report: ReliabilityReport = { format: "core-reliability-v1", evaluatorHash, settings,
    environment: { node: process.version, platform: process.platform, arch: process.arch }, sourceHash: fingerprint, rows,
    valid: rows.every(row => row.invalid === 0 && row.failed === 0 && row.timeout === 0 && row.busy === 0) };
  // Validate the full raw grid and recompute summaries even without a reference.
  compareReliability(report, report);
  const comparison = before ? compareReliability(before, report) : null;
  const regression = before ? performanceRegression(before, report) : null;
  const write = (name: string, data: unknown) => writeFileSync(join(root, name), JSON.stringify(data, null, 2) + "\n", { flag: "wx", mode: 0o600 });
  write("raw-report.json", report);
  for (const operation of ["recall", "context", "query"]) write(`${operation}.json`, rows.filter(row => row.operation === operation));
  write("comparison.json", comparison);
  write("performance-gate.json", regression);
  writeFileSync(join(root, "README.md"), "# SQLite运行容量报告\n\nRecall、Context、Query独立报告。完全虚构数据，单进程提供并发请求；SQLite仍同步串行执行，不是多进程吞吐量或跨机器SLO。每行保留原始延迟、错误/忙碌/超时、计时器让出延迟和RSS采样最大值（不是精确内存峰值）。没有硬取消保证；正常负载下任何失败/拒绝都令valid=false。比较只描述前后成本，不设事后阈值。\n", { flag: "wx", mode: 0o600 });
  process.stdout.write(JSON.stringify({ valid: report.valid, workloads: rows.length, responses: rows.reduce((sum, row) => sum + row.responses, 0), comparison: !!comparison,
    performanceGate: regression?.sufficientRounds ? regression.passed : "not established" }) + "\n");
  if (!report.valid || (regression?.sufficientRounds && !regression.passed)) process.exitCode = 1;
} catch {
  process.stderr.write("Reliability evaluation failed; inspect bounded settings and synthetic report evidence.\n"); process.exitCode = 1;
}
