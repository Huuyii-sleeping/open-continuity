import { parseCandidateSearch, skippedCandidates, type CandidateRetrievalRequest, type CandidateSearchResult } from "../../../core/retrieval/contracts.js";
import type { PostgresCandidateContext } from "./context.js";
import { postgresCandidateEligibility } from "./eligibility.js";
import { postgresCandidateResult } from "./result.js";

export async function postgresStructuredCandidates(context: PostgresCandidateContext, request: CandidateRetrievalRequest): Promise<CandidateSearchResult> {
  const input = parseCandidateSearch({ ...request, channel: "structured" }), skipped = skippedCandidates(input);
  if (skipped) return skipped;
  const { clauses, values } = postgresCandidateEligibility(input);
  return postgresCandidateResult(context, input, clauses, values, "structured_lookup");
}
