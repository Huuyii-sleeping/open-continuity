import { writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import type { EmbeddingProvider } from "../../src/core/retrieval/dense/index-contracts.js";
import type { DensePairVerifier } from "../../src/core/retrieval/dense/verification/contracts.js";
import type { CandidateReranker } from "../../src/core/retrieval/reranking/contracts.js";
import { evaluateDense, seedDenseEvaluation } from "./evaluator.js";
const option = (name: string) => process.argv.find(arg => arg.startsWith(`--${name}=`))?.slice(name.length + 3);
const providerPath = option("provider"), outputPath = option("output"), verifierPath = option("verifier"), rerankerPath = option("reranker");
if (!providerPath || !outputPath) throw new Error("Explicit local --provider=<module> and --output=<report> are required; no automatic installation or downloads");
if (process.argv.includes("--compare-rescue") && !verifierPath) throw new Error("--compare-rescue requires an explicit verifier");
const rerankingCandidateLimit = Number(option("reranking-candidates") ?? 20);
if ((rerankerPath && !verifierPath) || (option("reranking-candidates") && !rerankerPath) || !Number.isInteger(rerankingCandidateLimit) || rerankingCandidateLimit < 4 || rerankingCandidateLimit > 20)
  throw new Error("Explicit reranking requires a verifier and a candidate window from 4 to 20");
const { createProvider } = await import(pathToFileURL(resolve(providerPath)).href) as { createProvider(): Promise<EmbeddingProvider> };
const createVerifier = verifierPath ? (await import(pathToFileURL(resolve(verifierPath)).href) as { createVerifier(): Promise<DensePairVerifier & { warmup(): Promise<void> }> }).createVerifier : undefined;
const createReranker = rerankerPath ? (await import(pathToFileURL(resolve(rerankerPath)).href) as { createReranker(): Promise<CandidateReranker & { warmup(): Promise<void> }> }).createReranker : undefined;
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
  if (createVerifier && process.argv.includes("--compare-rescue")) {
    const report = await evaluateDense(provider, resolve(dataset), "hybrid", createVerifier, seed, "optimized", { candidateSelection: "bidirectional_rescue" }); reports.push(report);
    process.stdout.write(JSON.stringify({ dataset: report.dataset, mode: "hybrid", candidateSelection: report.candidateSelection, verifier: report.verifier, summary: report.summary }) + "\n");
  }
  if (createVerifier && createReranker) {
    const report = await evaluateDense(provider, resolve(dataset), "hybrid", createVerifier, seed, "optimized",
      { candidateSelection: "bidirectional_rescue", createReranker, rerankingCandidateLimit }); reports.push(report);
    process.stdout.write(JSON.stringify({ dataset: report.dataset, mode: "hybrid", reranker: report.reranker, summary: report.summary }) + "\n");
  }
}
writeFileSync(resolve(outputPath), JSON.stringify({ version: "dense-integration-eval-v2", note: "Fictional regression pools; previously observed, not a blind holdout. Unchanged quality-v1 labels. Optional author-generated fresh pool. Each arm replays the same source events/IDs/versions/timestamps per dataset. Three repeats per fixed fixture. Verifier preparation is reported outside warm latency.", reports }, null, 2) + "\n");
