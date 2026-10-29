import { isDeepStrictEqual } from "node:util";
import { OpenContinuityError } from "../../../shared/errors.js";
import type { CandidateSearchResult } from "../contracts.js";
import type { GroupedCandidate } from "./contracts.js";
import { snapshot } from "./snapshot.js";
function invalid(): never { throw new OpenContinuityError("STORAGE_ERROR", "Inconsistent candidate evidence", 500); }
export function groupCandidateEvidence(batches: CandidateSearchResult[], queryBatches: CandidateSearchResult[]): Map<string, GroupedCandidate> {
  const candidates = new Map<string, GroupedCandidate>();
  for (const batch of [...queryBatches, ...batches.filter(b => b.channel === "structured")]) {
    const seen = new Set<string>();
    for (const hit of batch.hits) {
      const previous = candidates.get(hit.memory.id);
      if (previous && !isDeepStrictEqual(snapshot(previous.memory), snapshot(hit.memory))) invalid();
      if (seen.has(hit.memory.id)) continue;
      seen.add(hit.memory.id);
      // A filter-only match cannot create an answer candidate.
      if (batch.channel === "structured" && !previous) continue;
      const item = previous ?? { memory: hit.memory, hits: [] };
      item.hits.push({ hit, implementation: batch.implementation });
      candidates.set(hit.memory.id, item);
    }
  }
  return candidates;
}
