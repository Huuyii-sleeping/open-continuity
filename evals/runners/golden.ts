import { resolve } from "node:path";
import { evaluateGoldenDataset, loadGoldenDataset } from "./golden-evaluator.js";

const datasetPath = resolve(process.argv[2] || "evals/datasets/golden-v1.json");
const result = await evaluateGoldenDataset(loadGoldenDataset(datasetPath));
process.stdout.write(JSON.stringify(result, null, 2) + "\n");
