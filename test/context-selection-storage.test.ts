import { afterEach } from "vitest";
import { candidateRuntime } from "../evals/candidates/runtime.js";
import { contextSelectionConformance } from "./helpers/context-selection-conformance.js";
const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0)) await cleanup(); });
for (const backend of ["inmemory", "json", "sqlite", "postgres-pg-mem"] as const) {
  contextSelectionConformance(backend, async () => {
    const runtime = await candidateRuntime(process.cwd(), backend);
    cleanups.push(runtime.close);
    return runtime;
  });
}
