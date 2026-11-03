import type { CandidateReaderSet, CandidateSearchRequest, CandidateSearchResult, SyncCandidateReaderSet } from "./contracts.js";
import { parseCandidateSearch } from "./contracts.js";
import { OpenContinuityError } from "../../shared/errors.js";

/** Compatibility dispatch only. There is no matching or ranking algorithm here. */
export function dispatchCandidateSearch(request: CandidateSearchRequest, readers: SyncCandidateReaderSet): CandidateSearchResult;
export function dispatchCandidateSearch(request: CandidateSearchRequest, readers: CandidateReaderSet): CandidateSearchResult | Promise<CandidateSearchResult>;
export function dispatchCandidateSearch(request: CandidateSearchRequest, readers: CandidateReaderSet): CandidateSearchResult | Promise<CandidateSearchResult> {
  const { channel, ...input } = parseCandidateSearch(request);
  const read = readers[channel];
  if (!read) throw new OpenContinuityError("VALIDATION_ERROR", "Candidate reader is not registered", 400);
  return read.call(readers, input);
}
