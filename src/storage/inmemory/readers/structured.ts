import { parseCandidateSearch, skippedCandidates, type CandidateRetrievalRequest, type CandidateSearchResult } from "../../../core/retrieval/contracts.js";
import type { InMemoryCandidateContext } from "./context.js";
import { eligibleInMemoryCandidates } from "./eligibility.js";
import { inMemoryCandidateResult } from "./result.js";

export function inMemoryStructuredCandidates(context: InMemoryCandidateContext, request: CandidateRetrievalRequest): CandidateSearchResult {
  const input = parseCandidateSearch({ ...request, channel: "structured" }), skipped = skippedCandidates(input);
  if (skipped) return skipped;
  return inMemoryCandidateResult(eligibleInMemoryCandidates(context, input), input, "structured_lookup");
}
