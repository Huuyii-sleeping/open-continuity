import type { ParsedAgenticQueryInput, RecallResult } from "../../shared/types.js";
import type { QueryEvidenceReader } from "./contracts.js";
export async function recallQueryStep(reader: QueryEvidenceReader, input: ParsedAgenticQueryInput, query: string, requireUserConfirmed: boolean): Promise<RecallResult> {
  return reader.recall({
    userId: input.userId, agentId: input.agentId, query: query, key: input.key, kind: input.kind, scope: input.scope, taskId: input.taskId,
    includePrivate: input.includePrivate, limit: 100, cursor: undefined,
  }, { requireUserConfirmed: requireUserConfirmed });
}
