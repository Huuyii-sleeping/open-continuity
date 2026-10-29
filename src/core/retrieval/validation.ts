import { OpenContinuityError } from "../../shared/errors.js";
import type { RetrievalChannel } from "../../shared/types.js";
import type { CandidateSearchResult } from "./contracts.js";
import { validateFullTextEvidence } from "./full-text/validate-evidence.js";
import { validateDenseEvidence } from "./dense/validate-evidence.js";
function invalid(): never { throw new OpenContinuityError("STORAGE_ERROR", "Inconsistent candidate evidence", 500); }

export function validateCandidateBatches(batches: CandidateSearchResult[]): void {
  const channels = new Set<RetrievalChannel>();
  for (const batch of batches) {
    if (channels.has(batch.channel) || !["exact", "structured", "full_text", "dense"].includes(batch.channel) || batch.hits.length > 100
      || !["ok", "skipped"].includes(batch.status) || typeof batch.truncated !== "boolean"
      || (batch.status === "skipped" && (batch.hits.length || batch.truncated))
      || (batch.implementation === "not_run" && batch.hits.length)) invalid();
    channels.add(batch.channel);
    if (batch.channel === "dense") validateDenseEvidence(batch);
    else if (batch.dense || batch.implementation === "sqlite_dense_experimental") invalid();
    batch.hits.forEach((hit, i) => {
      if (hit.verification && batch.channel !== "dense") invalid();
      if (hit.channel !== batch.channel || hit.channelRank !== i + 1 || !hit.memory.id) invalid();
      if (batch.channel === "dense") return;
      if (hit.score.model === "fts5_bm25" || hit.score.model === "token_edit_distance") validateFullTextEvidence(hit, batch, i);
      else if (hit.score.model !== "none" || hit.score.value !== null || hit.score.direction !== "not_applicable"
        || !["filter_order", "match_order"].includes(hit.rankMeaning)) invalid();
    });
  }
}
