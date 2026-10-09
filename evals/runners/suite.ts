import { resolve } from "node:path";
import { evaluateSuite, loadSuiteDataset } from "./suite-evaluator.js";

const datasetPath = resolve(process.argv[2] || "evals/datasets/suite-v1.json");
const result = await evaluateSuite(loadSuiteDataset(datasetPath));
process.stdout.write(JSON.stringify(result, null, 2) + "\n");
if (!result.passed) process.exitCode = 1;
