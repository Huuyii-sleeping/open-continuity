import { exactCandidateKey, parseCandidateSearch, skippedCandidates, type CandidateRetrievalRequest, type CandidateSearchResult } from "../../../core/retrieval/contracts.js";
import type { InMemoryCandidateContext } from "./context.js";
import { eligibleInMemoryCandidates } from "./eligibility.js";
import { inMemoryCandidateResult } from "./result.js";

export function inMemoryExactCandidates(context: InMemoryCandidateContext, request: CandidateRetrievalRequest): CandidateSearchResult {
  const input = parseCandidateSearch({ ...request, channel: "exact" }), skipped = skippedCandidates(input);
  if (skipped) return skipped;
  const rows = eligibleInMemoryCandidates(context, input).filter(memory => memory.key === exactCandidateKey(input));
  return inMemoryCandidateResult(rows, input, "structured_lookup");
}
