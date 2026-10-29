import { writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import type { EmbeddingProvider } from "../../src/core/retrieval/dense/index-contracts.js";
import type { DensePairVerifier } from "../../src/core/retrieval/dense/verification/contracts.js";
import { evaluateDense, seedDenseEvaluation } from "./evaluator.js";
const option = (name: string) => process.argv.find(arg => arg.startsWith(`--${name}=`))?.slice(name.length + 3);
const providerPath = option("provider"), outputPath = option("output"), verifierPath = option("verifier");
if (!providerPath || !outputPath) throw new Error("Explicit local --provider=<module> and --output=<report> are required; no automatic installation or downloads");
const { createProvider } = await import(pathToFileURL(resolve(providerPath)).href) as { createProvider(): Promise<EmbeddingProvider> };
const createVerifier = verifierPath ? (await import(pathToFileURL(resolve(verifierPath)).href) as { createVerifier(): Promise<DensePairVerifier & { warmup(): Promise<void> }> }).createVerifier : undefined;
const provider = await createProvider(), reports = [];
const datasets = ["evals/datasets/quality-v1.json", "evals/datasets/dense-admission-regression-v1.json", "evals/datasets/dense-pair-regression-v1.json", ...(option("dataset") ? [option("dataset")!] : [])];
for (const dataset of datasets) {
  const seed = await seedDenseEvaluation(resolve(dataset));
  for (const mode of ["off", "miss_only", "hybrid"] as const) {
    const report = await evaluateDense(provider, resolve(dataset), mode, undefined, seed); reports.push(report);
    process.stdout.write(JSON.stringify({ dataset: report.dataset, mode, verifier: null, summary: report.summary }) + "\n");
  }
  if (process.argv.includes("--compare-ranking")) for (const mode of ["miss_only", "hybrid"] as const) {
    const report = await evaluateDense(provider, resolve(dataset), mode, undefined, seed, "legacy"); reports.push(report);
    process.stdout.write(JSON.stringify({ dataset: report.dataset, mode, ranking: "legacy", verifier: null, summary: report.summary }) + "\n");
  }
  if (createVerifier) for (const mode of ["miss_only", "hybrid"] as const) {
    const report = await evaluateDense(provider, resolve(dataset), mode, createVerifier, seed); reports.push(report);
    process.stdout.write(JSON.stringify({ dataset: report.dataset, mode, verifier: report.verifier, summary: report.summary }) + "\n");
  }
}
writeFileSync(resolve(outputPath), JSON.stringify({ version: "dense-integration-eval-v2", note: "Fictional regression pools; previously observed, not a blind holdout. Unchanged quality-v1 labels. Optional author-generated fresh pool. Each arm replays the same source events/IDs/versions/timestamps per dataset. Three repeats per fixed fixture. Verifier preparation is reported outside warm latency.", reports }, null, 2) + "\n");
