import { expect, it } from "vitest";
import { rankEvidence } from "../../../src/core/retrieval/ranking.js";
import { lexicalBatch } from "../../helpers/ranking-route-fixtures.js";
it("RRF: fuses genuine channel positions while structured qualification adds no relevance", () => {
  const full = lexicalBatch(), memory = full.hits[1].memory;
  const exact = { ...full, channel: "exact" as const, implementation: "structured_lookup" as const, ordering: "updated_at_id" as const, hits: [{ memory, channel: "exact" as const, channelRank: 1, rankMeaning: "match_order" as const, score: { model: "none" as const, value: null, direction: "not_applicable" as const }, match: { type: "exact_key" as const, reason: "key_equals" as const, filters: [] } }] };
  const structured = { ...exact, channel: "structured" as const, hits: [{ ...exact.hits[0], channel: "structured" as const, rankMeaning: "filter_order" as const, match: { type: "structured_filter" as const, reason: "explicit_filters" as const, filters: [] } }] };
  const result = rankEvidence([full, exact, structured], { rrfK: 60, exactPrecedence: false, fusion: "rrf" });
  expect(result[0].memory.id).toBe(memory.id); expect(result[0].retrieval.scoreModel).toBe("rrf");
  expect(result[0].retrieval.evidence?.find(signal => signal.channel === "structured")?.contribution).toBe(0);
  expect(result[0].score).toBeCloseTo(1 / 61 + 1 / 62);
});
