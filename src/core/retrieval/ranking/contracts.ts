import type { ResolvedMemory } from "../../../shared/types.js";
import type { CandidateSearchResult, ScoredSearchHit } from "../contracts.js";
export const RANKING_VERSION = "core-ranking-v2" as const;
export interface GroupedCandidate { memory: ResolvedMemory; hits: Array<{ hit: ScoredSearchHit; implementation: CandidateSearchResult["implementation"] }>; }
