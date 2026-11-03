import { candidateQuery, parseCandidateSearch, skippedCandidates, type CandidateRetrievalRequest, type CandidateSearchResult } from "../../../core/retrieval/contracts.js";
import type { PostgresCandidateContext } from "./context.js";
import { postgresCandidateEligibility } from "./eligibility.js";
import { postgresCandidateResult } from "./result.js";

export async function postgresFullTextCandidates(context: PostgresCandidateContext, request: CandidateRetrievalRequest): Promise<CandidateSearchResult> {
  const input = parseCandidateSearch({ ...request, channel: "full_text" }), skipped = skippedCandidates(input);
  if (skipped) return skipped;
  const { clauses, values } = postgresCandidateEligibility(input);
  values.push(candidateQuery(input));
  clauses.push(`(strpos(lower(memory_key), lower($${values.length}::text)) > 0 OR strpos(lower(value::text), lower($${values.length}::text)) > 0)`);
  return postgresCandidateResult(context, input, clauses, values, "postgres_substring_fallback");
}
