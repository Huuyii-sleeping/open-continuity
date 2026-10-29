import type { BuiltinSyncCandidateReaders } from "../../../core/retrieval/contracts.js";
import type { SqliteCandidateContext } from "./context.js";
import { sqliteExactCandidates } from "./exact.js";
import { sqliteStructuredCandidates } from "./structured.js";
import { sqliteFullTextCandidates } from "./full-text.js";

export function createSqliteCandidateReaders(context: SqliteCandidateContext): BuiltinSyncCandidateReaders {
  return Object.freeze<BuiltinSyncCandidateReaders>({
    exact: input => sqliteExactCandidates(context, input),
    structured: input => sqliteStructuredCandidates(context, input),
    full_text: input => sqliteFullTextCandidates(context, input),
  });
}
