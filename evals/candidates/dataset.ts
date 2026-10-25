import { readFileSync } from "node:fs";
import { z } from "zod";
import { parseDataset, type BaselineCase } from "../baseline/dataset.js";
import { memoryKindSchema, retrievalChannelSchema, type MemoryKind, type RetrievalChannel } from "../../src/shared/types.js";

const schema = z.object({ version: z.literal("candidate-v1"), description: z.string(), cases: z.array(z.object({
  channel: retrievalChannelSchema, key: z.string().min(1).optional(), kind: memoryKindSchema.optional(), requireUserConfirmed: z.boolean().default(false),
  sqliteOnlyRequired: z.boolean().default(false), spec: z.unknown(),
}).strict()).min(1) }).strict();
export interface CandidateCase {
  source: "core-baseline-v1" | "candidate-v1"; channel: RetrievalChannel; spec: BaselineCase;
  key?: string; kind?: MemoryKind; requireUserConfirmed: boolean; sqliteOnlyRequired: boolean;
}
export function parseCandidateDataset(raw: unknown): CandidateCase[] {
  const parsed = schema.parse(raw);
  const verified = parseDataset({ version: "core-baseline-v1", description: parsed.description, provenance: { legacyCommit: "candidate-v1",legacyPath: "candidate-v1",legacyRetrievalCount: 0 }, rounds: 3,ks: [1,3,5],closedWorld: true,cases: parsed.cases.map(c => c.spec) });
  return parsed.cases.map((c,index) => ({ ...c,source: "candidate-v1",spec: verified.cases[index]! }));
}
export function loadCandidateDataset(path: string): CandidateCase[] { return parseCandidateDataset(JSON.parse(readFileSync(path,"utf8"))); }
