import { parseCandidateSearch, skippedCandidates, type CandidateRetrievalRequest, type CandidateSearchResult } from "../../../core/retrieval/contracts.js";
import type { SqliteCandidateContext } from "./context.js";
import { sqliteCandidateEligibility } from "./eligibility.js";
import { sqliteLookupCandidates } from "./lookup.js";

export function sqliteStructuredCandidates(context: SqliteCandidateContext, request: CandidateRetrievalRequest): CandidateSearchResult {
  context.assertOpen();
  const input = parseCandidateSearch({ ...request, channel: "structured" }), skipped = skippedCandidates(input);
  if (skipped) return skipped;
  const { clauses, values } = sqliteCandidateEligibility(input);
  return sqliteLookupCandidates(context, input, clauses, values);
}
