import type { MemoryEvent, ResolvedMemory } from "../../shared/types.js";
import type { MemoryPersistence, LegacyMemoryLookup, MemoryRepository } from "./storage-contract.js";
import type { CandidateReaderSet, CandidateSearchStore } from "../retrieval/contracts.js";
import type { FactGroupStore } from "../facts/contracts.js";
export interface MemoryStore extends MemoryPersistence, LegacyMemoryLookup {
  /** Explicit support for the atomic reviewed-Handoff snapshot guard. */
  readonly handoffReviewVersion?: "handoff-review-v1";
  readonly lexicalIndexVersion?: "json-literal-values-v1";
  readonly lexicalFallbackVersion?: "latin-one-edit-v1";
  // Optional on legacy/custom implementations; concrete stores implement MemoryRepository.
  list?: MemoryRepository["list"];
  // Staged phase-2 API; legacy/custom stores need not claim this capability.
  searchCandidates?: CandidateSearchStore["searchCandidates"];
  readonly candidateReaders?: CandidateReaderSet;
  readFactGroup?: FactGroupStore["readFactGroup"];
}
export interface MemoryReceiptLike { event: MemoryEvent; duplicate: boolean; current: ResolvedMemory; evolution?: import("../../shared/types.js").MemoryEvolutionReceipt; }
