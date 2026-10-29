import { OpenContinuityError } from "../../../shared/errors.js";
import type { CandidateSearchResult, ScoredSearchHit } from "../contracts.js";
import { oneWordEdit } from "./lexical-fallback.js";
function invalid(): never { throw new OpenContinuityError("STORAGE_ERROR", "Inconsistent candidate evidence", 500); }

export function validateFullTextEvidence(hit: ScoredSearchHit, batch: CandidateSearchResult, i: number): void {
  if (hit.score.model === "fts5_bm25") {
        if (batch.channel !== "full_text" || hit.rankMeaning !== "relevance" || !Number.isFinite(hit.score.value) || hit.score.direction !== "lower_is_better") invalid();
        const previous = batch.hits[i-1];
        if (previous?.score.model === "fts5_bm25" && previous.score.value > hit.score.value) invalid();
      } else if (hit.score.model === "token_edit_distance") {
        const correction = hit.match.correction;
        if (batch.channel !== "full_text" || hit.rankMeaning !== "relevance" || hit.score.value !== 1 || hit.score.direction !== "lower_is_better"
          || hit.match.type !== "one_edit_terms" || hit.match.reason !== "all_terms_one_edit" || !correction
          || !/^[a-z]{5,32}$/.test(correction.queryToken) || oneWordEdit(correction.queryToken, correction.matchedToken) !== correction.edit
          || batch.implementation !== "sqlite_one_edit_fallback" || !batch.lexicalFallback?.used) invalid();
      }
}
