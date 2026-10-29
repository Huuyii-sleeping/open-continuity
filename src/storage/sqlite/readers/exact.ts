import { exactCandidateKey, parseCandidateSearch, skippedCandidates, type CandidateRetrievalRequest, type CandidateSearchResult } from "../../../core/retrieval/contracts.js";
import type { SqliteCandidateContext } from "./context.js";
import { sqliteCandidateEligibility } from "./eligibility.js";
import { sqliteLookupCandidates } from "./lookup.js";

export function sqliteExactCandidates(context: SqliteCandidateContext, request: CandidateRetrievalRequest): CandidateSearchResult {
  context.assertOpen();
  const input = parseCandidateSearch({ ...request, channel: "exact" }), skipped = skippedCandidates(input);
  if (skipped) return skipped;
  const { clauses, values } = sqliteCandidateEligibility(input);
  clauses.push("m.memory_key = ?"); values.push(exactCandidateKey(input)!);
  return sqliteLookupCandidates(context, input, clauses, values);
}
