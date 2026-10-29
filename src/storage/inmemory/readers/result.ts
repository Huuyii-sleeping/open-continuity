import type { ResolvedMemory } from "../../../shared/types.js";
import { unscoredCandidate, type CandidateSearchInput, type CandidateSearchResult } from "../../../core/retrieval/contracts.js";

export function inMemoryCandidateResult(rows: ResolvedMemory[], input: CandidateSearchInput, implementation: CandidateSearchResult["implementation"]): CandidateSearchResult {
  rows.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt) || b.id.localeCompare(a.id));
  return { channel: input.channel, status: "ok", hits: structuredClone(rows.slice(0, input.limit)).map((memory, index) => unscoredCandidate(memory, input, index)),
    truncated: rows.length > input.limit, ordering: "updated_at_id", implementation };
}
