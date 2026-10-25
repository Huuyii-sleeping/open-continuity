import { resolve, join } from "node:path";
import { readFileSync, writeFileSync } from "node:fs";
import { parseArgs } from "node:util";
import { pathToFileURL } from "node:url";
import { createHash } from "node:crypto";

// Same bounded driver workload for both implementations, not a claim of SQL hard cancellation.
// Keep the harness alive even for the old implementation's unref'ed timeout timers.
const harness = setInterval(() => {}, 1000);
try {
  const { values } = parseArgs({ options: { source: { type: "string", default: "." }, output: { type: "string" } }, strict: true });
  if (!values.output) throw new Error("Explicit new report path required");
  const source = resolve(values.source!);
  const module = await import(pathToFileURL(join(source, "src/core/memory-service.ts")).href) as typeof import("../../src/core/memory-service.js");
  let release!: () => void;
  const pending = new Promise<void>(resolve => { release = resolve; });
  let reads = 0;
  const service = new module.MemoryService({ appendRemember: () => { throw new Error("Unused fictional write"); }, appendForget: () => { throw new Error("Unused fictional write"); },
    history: () => ({ events: [], nextCursor: null }), recall: async () => { reads++; await pending; return { memories: [], nextCursor: null }; } }, {},
    { defaultTokenBudget: 1024, maxTokenBudget: 4096, maxMemories: 20 },
    { defaultMaxSteps: 3, maxSteps: 4, defaultTimeoutMs: 10, maxTimeoutMs: 1000, maxSubqueries: 3, historyLimit: 50 }, { maxPendingReads: 1 });
  const outcomes: string[] = [];
  for (let n = 0; n < 4; n++) {
    try { const result = await service.query({ userId: "fictional-fault-user", agentId: "fictional-fault-agent", query: "fictional slow", timeoutMs: 10 }); outcomes.push(result.execution.stoppedReason); }
    catch (error) { outcomes.push(error && typeof error === "object" && "code" in error ? String(error.code) : "unknown_error"); }
  }
  const readsBeforeSettlement = reads;
  release(); await new Promise<void>(resolve => setTimeout(resolve, 30));
  const readsAfterSettlement = reads;
  const status = service.readRuntimeStatus?.() ?? null;
  const recovered = (await service.query({ userId: "fictional-fault-user", agentId: "fictional-fault-agent", query: "fictional slow" })).execution.stoppedReason;
  await service.close();
  const protectedRuntime = typeof service.readRuntimeStatus === "function";
  const observations = { outcomes, readsBeforeSettlement, readsAfterSettlement, status, recovered };
  const observedProtection = readsBeforeSettlement === 1 && readsAfterSettlement === 1
    && outcomes.join(",") === "timeout,RUNTIME_BUSY,RUNTIME_BUSY,RUNTIME_BUSY" && status?.pendingReads === 0 && recovered === "completed";
  writeFileSync(resolve(values.output), JSON.stringify({ format: "core-read-fault-v1", evaluatorHash: createHash("sha256").update(readFileSync(new URL("./faults.ts", import.meta.url))).digest("hex"),
    protectedRuntime, observedProtection, observations, workload: "four sequential requests sharing an unresolved fake driver; release only after all responses; no SQL model or cancellation" }, null, 2) + "\n", { flag: "wx", mode: 0o600 });
  process.stdout.write(JSON.stringify({ protectedRuntime, observedProtection, readsBeforeSettlement, readsAfterSettlement }) + "\n");
  if (protectedRuntime && !observedProtection) process.exitCode = 1;
} catch { process.stderr.write("Synthetic read fault evaluation failed.\n"); process.exitCode = 1; }
finally { clearInterval(harness); }
