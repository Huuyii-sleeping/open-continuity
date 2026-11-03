import { exactCandidateKey, parseCandidateSearch, skippedCandidates, type CandidateRetrievalRequest, type CandidateSearchResult } from "../../../core/retrieval/contracts.js";
import type { PostgresCandidateContext } from "./context.js";
import { postgresCandidateEligibility } from "./eligibility.js";
import { postgresCandidateResult } from "./result.js";

export async function postgresExactCandidates(context: PostgresCandidateContext, request: CandidateRetrievalRequest): Promise<CandidateSearchResult> {
  const input = parseCandidateSearch({ ...request, channel: "exact" }), skipped = skippedCandidates(input);
  if (skipped) return skipped;
  const { clauses, values } = postgresCandidateEligibility(input);
  values.push(exactCandidateKey(input)!); clauses.push("memory_key = $" + values.length);
  return postgresCandidateResult(context, input, clauses, values, "structured_lookup");
}
