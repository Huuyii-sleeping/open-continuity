import type { CandidateReaderSet, CandidateSearchStore } from "../contracts.js";

/** Old custom stores keep their original single method through this explicit bridge. */
export function legacyCandidateReaders(store: CandidateSearchStore): CandidateReaderSet {
  return Object.freeze({
    exact: input => store.searchCandidates({ ...input, channel: "exact" }),
    structured: input => store.searchCandidates({ ...input, channel: "structured" }),
    full_text: input => store.searchCandidates({ ...input, channel: "full_text" }),
  });
}
