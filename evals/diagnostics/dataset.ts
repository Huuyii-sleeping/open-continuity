import { readFileSync } from "node:fs";
import { isDeepStrictEqual } from "node:util";
import { z } from "zod";
import { jsonValueSchema, memoryFactSchema } from "../../src/shared/types.js";
import { loadDataset } from "../baseline/dataset.js";

const judgmentSchema = z.object({ relevant: z.array(z.string()), forbidden: z.array(z.string()), ordered: z.array(z.string()).optional(),
  values: z.array(z.object({ label: z.string(), value: jsonValueSchema, version: z.number().int().positive().optional() }).strict()).optional() }).strict();
const recordSchema = z.object({ label: z.string().min(1), key: z.string().min(1), value: jsonValueSchema,
  userId: z.string().optional(), agentId: z.string().optional(), sensitivity: z.enum(["public", "private"]).optional(), userConfirmed: z.boolean().optional(),
  scope: z.enum(["user", "agent", "task"]).optional(), taskId: z.string().optional(), idempotencyKey: z.string().optional(),
  expectedVersion: z.number().int().nonnegative().optional(), writeMode: z.enum(["replace", "merge"]).optional(), fact: memoryFactSchema.optional() }).strict();
export const diagnosticCaseSchema = z.object({
  id: z.string().min(1), partition: z.enum(["legacy", "development", "acceptance_exposed"]), status: z.enum(["required", "challenge"]),
  recallStatus: z.enum(["required", "challenge"]).optional(), category: z.string().min(1), rationale: z.string().min(1), query: z.string().min(1),
  limit: z.number().int().min(1).max(20).optional(), tokenBudget: z.number().int().min(64).max(4096).default(4096),
  candidateLimit: z.number().int().min(1).max(100).default(50), taskId: z.string().optional(), scope: z.enum(["user", "agent", "task"]).optional(),
  subqueries: z.array(z.string().min(1)).min(1).max(3).optional(),
  grades: z.record(z.string(), z.number().int().min(1).max(3)).optional(),
  memories: z.array(recordSchema).default([]), expected: judgmentSchema, recallExpected: judgmentSchema.optional(), queryExpected: judgmentSchema.optional(),
}).strict();
export type DiagnosticCase = z.infer<typeof diagnosticCaseSchema>;
export type DiagnosticJudgment = z.infer<typeof judgmentSchema>;
export const ENDPOINTS = ["recall", "context", "query"] as const;
export type Endpoint = typeof ENDPOINTS[number];
export const ACTOR = { userId: "baseline-fictional-user", agentId: "baseline-fictional-reader" };
export const SETTINGS = { rounds: 3, repeats: 3, ks: [1, 3, 5], probeLimit: 100, writeSpacingMs: 2 };

export function validateCases(cases: DiagnosticCase[]) {
  if (!cases.length || new Set(cases.map(item => item.id)).size !== cases.length) throw new Error("Invalid diagnostic case identities");
  for (const item of cases) {
    const labels = item.memories.map(record => record.label);
    if (new Set(labels).size !== labels.length || item.memories.some(record => (record.scope === "task" && !record.taskId)
      || (record.fact && (!record.userConfirmed || record.expectedVersion === undefined)))) throw new Error("Invalid fixture records");
    for (const expected of [item.expected, item.recallExpected, item.queryExpected].filter(value => value !== undefined)) {
      for (const list of [expected.relevant, expected.forbidden, expected.ordered ?? [], expected.values?.map(value => value.label) ?? []]) {
        if (new Set(list).size !== list.length || list.some(label => !labels.includes(label))) throw new Error("Invalid diagnostic labels");
      }
      if (expected.relevant.some(label => expected.forbidden.includes(label))
        || expected.ordered?.some(label => !expected.relevant.includes(label)) || expected.values?.some(value => !expected.relevant.includes(value.label))) throw new Error("Contradictory diagnostic judgment");
    }
    if (Object.keys(item.grades ?? {}).some(label => !item.expected.relevant.includes(label))) throw new Error("Invalid graded relevance");
  }
  return cases;
}
export function loadDiagnosticCases(legacyPath: string, supplementalPath: string) {
  const legacy = loadDataset(legacyPath);
  const supplement = z.object({ version: z.literal("retrieval-diagnostics-v1"), provenance: z.literal("wholly_fictional_personal_project"),
    acceptance: z.literal("fixed_but_exposed_not_blind_heldout"), cases: z.array(diagnosticCaseSchema).min(1) }).strict().parse(JSON.parse(readFileSync(supplementalPath, "utf8")));
  if (supplement.cases.some(item => item.partition === "legacy")) throw new Error("Supplement cannot redefine legacy cases");
  const cases = legacy.cases.map(item => diagnosticCaseSchema.parse({ id: item.id, partition: "legacy", status: item.status,
    recallStatus: item.recallStatus, category: item.category, rationale: "Original core-baseline-v1 judgment, unchanged; Query is a separate new observation.",
    query: item.query, limit: item.limit, taskId: item.taskId, scope: item.scope, memories: [...item.memories ?? [], ...item.writes ?? []],
    expected: item.expected, recallExpected: item.recallExpected, grades: item.grades }));
  // Explicit guard against accidentally modifying legacy judgments in the adapter.
  for (let i = 0; i < cases.length; i++) if (!isDeepStrictEqual(cases[i]!.expected, legacy.cases[i]!.expected)
    || !isDeepStrictEqual(cases[i]!.recallExpected, legacy.cases[i]!.recallExpected) || !isDeepStrictEqual(cases[i]!.grades, legacy.cases[i]!.grades)) throw new Error("Legacy judgments changed");
  return validateCases([...cases, ...supplement.cases]);
}
export function judgmentFor(item: DiagnosticCase, endpoint: Endpoint) {
  return endpoint === "recall" ? item.recallExpected ?? item.expected : endpoint === "query" ? item.queryExpected ?? item.expected : item.expected;
}
