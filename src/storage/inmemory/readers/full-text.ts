import { candidateQuery, parseCandidateSearch, skippedCandidates, type CandidateRetrievalRequest, type CandidateSearchResult } from "../../../core/retrieval/contracts.js";
import type { InMemoryCandidateContext } from "./context.js";
import { eligibleInMemoryCandidates } from "./eligibility.js";
import { inMemoryCandidateResult } from "./result.js";

export function inMemoryFullTextCandidates(context: InMemoryCandidateContext, request: CandidateRetrievalRequest): CandidateSearchResult {
  const input = parseCandidateSearch({ ...request, channel: "full_text" }), skipped = skippedCandidates(input);
  if (skipped) return skipped;
  const query = candidateQuery(input).toLowerCase();
  const rows = eligibleInMemoryCandidates(context, input).filter(memory => memory.key.toLowerCase().includes(query) || JSON.stringify(memory.value).toLowerCase().includes(query));
  return inMemoryCandidateResult(rows, input, "inmemory_compatibility");
}
