import { readFileSync } from "node:fs";
import { z } from "zod";

const judgment = z.object({ relevant: z.array(z.string()), forbidden: z.array(z.string()), ordered: z.array(z.string()).optional(), values: z.array(z.object({ label: z.string(), value: z.unknown(), version: z.number().int().positive().optional() })).optional() });
const memory = z.object({
  label: z.string().min(1), key: z.string().min(1), value: z.unknown(),
  userId: z.string().optional(), agentId: z.string().optional(),
  sensitivity: z.enum(["public", "private"]).optional(), userConfirmed: z.boolean().optional(),
  scope: z.enum(["user", "agent", "task"]).optional(), taskId: z.string().optional(),
  idempotencyKey: z.string().optional(), expectedVersion: z.number().int().nonnegative().optional(),
  writeMode: z.enum(["replace", "merge"]).optional(),
});
const datasetSchema = z.object({
  version: z.literal("core-baseline-v1"), description: z.string(), provenance: z.object({ legacyCommit: z.string(), legacyPath: z.string(), legacyRetrievalCount: z.number() }),
  rounds: z.number().int().min(2).max(20), ks: z.array(z.number().int().min(1).max(20)).min(1), closedWorld: z.literal(true),
  cases: z.array(z.object({
    id: z.string(), status: z.enum(["required", "challenge"]), category: z.string(), query: z.string(),
    limit: z.number().int().min(1).max(20).optional(), taskId: z.string().optional(), scope: z.enum(["user", "task", "agent"]).optional(),
    memories: z.array(memory).optional(), writes: z.array(memory).optional(), expected: judgment, recallExpected: judgment.optional(),
    grades: z.record(z.string(), z.number().int().min(1).max(3)).optional(),
    recallStatus: z.enum(["required", "challenge"]).optional(),
  })).min(1),
});
export type BaselineDataset = z.infer<typeof datasetSchema>;
export type BaselineCase = BaselineDataset["cases"][number];
export function parseDataset(raw: unknown): BaselineDataset {
  const dataset = datasetSchema.parse(raw);
  const ids = new Set<string>();
  if (new Set(dataset.ks).size !== dataset.ks.length) throw new Error("Duplicate K");
  for (const testCase of dataset.cases) {
    if (ids.has(testCase.id)) throw new Error("Duplicate case id");
    ids.add(testCase.id);
    const records = [...testCase.memories ?? [], ...testCase.writes ?? []];
    const labels = new Set(records.map((record) => record.label));
    if (labels.size !== records.length) throw new Error("Duplicate fixture label");
    for (const record of records) if (record.scope === "task" && !record.taskId) throw new Error("Task fixture missing taskId");
    for (const expected of [testCase.expected, testCase.recallExpected].filter((item) => item !== undefined)) {
      for (const list of [expected.relevant, expected.forbidden]) {
        if (new Set(list).size !== list.length || list.some((label) => !labels.has(label))) throw new Error("Invalid judgment label");
      }
      if (expected.relevant.some((label) => expected.forbidden.includes(label))) throw new Error("Contradictory judgment");
      if (expected.ordered?.some((label) => !expected.relevant.includes(label))) throw new Error("Invalid ordered judgment");
      if (expected.values?.some((item) => !expected.relevant.includes(item.label))) throw new Error("Invalid value judgment");
    }
    if (Object.keys(testCase.grades ?? {}).some((label) => !testCase.expected.relevant.includes(label))) throw new Error("Invalid grade judgment");
  }
  return dataset;
}
export function loadDataset(path: string) { return parseDataset(JSON.parse(readFileSync(path, "utf8"))); }
