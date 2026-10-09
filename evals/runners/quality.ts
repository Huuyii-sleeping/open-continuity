import { resolve } from "node:path";
import { evaluateQuality, loadQualityDataset } from "./quality-evaluator.js";

const datasetPath = resolve(process.argv[2] || "evals/datasets/quality-v1.json");
const result = await evaluateQuality(loadQualityDataset(datasetPath));
process.stdout.write(JSON.stringify(result, null, 2) + "\n");
if (!result.passed) process.exitCode = 1;
