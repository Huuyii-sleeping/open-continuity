import { OpenContinuityError } from "../../../shared/errors.js";
import type { RetrievalChannel } from "../../../shared/types.js";
import type { CandidateSearchResult } from "../contracts.js";

export function channelResult(result: CandidateSearchResult, channel: RetrievalChannel): CandidateSearchResult {
  if (result.channel !== channel || result.hits.some(hit => hit.channel !== channel)) {
    throw new OpenContinuityError("STORAGE_ERROR", "Candidate reader returned another channel", 500);
  }
  return result;
}
