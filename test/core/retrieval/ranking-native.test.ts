import { lexicalBatch } from "../../helpers/ranking-route-fixtures.js";
import { expect, it } from "vitest";
import { rankEvidence } from "../../../src/core/retrieval/ranking.js";
import type { CandidateSearchResult, ScoredSearchHit } from "../../../src/core/retrieval/contracts.js";
import { routeMemory } from "../../helpers/core-route-fixtures.js";

it("native ranking: preserves BM25 order over recency without claiming cross-channel fusion", () => {
  const result = rankEvidence([lexicalBatch()], { rrfK: 60, exactPrecedence: true, fusion: "rrf" });
  expect(result.map(item => item.memory.id)).toEqual(["fictional-focused", "fictional-newer"]);
  expect(result[0].retrieval).toMatchObject({ scoreModel: "rank_reciprocal", fusedScore: null, selectionReasons: ["query_match", "single_channel_order", "current_memory_snapshot"] });
});
