import { expect, it } from "vitest";
import { paginateRankedEvidence } from "../../../src/core/retrieval/pagination.js";
import { rankEvidence } from "../../../src/core/retrieval/ranking.js";
import { decodeRetrievalCursor } from "../../../src/core/pagination/retrieval.js";
import { lexicalBatch } from "../../helpers/ranking-route-fixtures.js";
it("ranked pagination: resumes after the score boundary with no duplicate or missing item", () => {
  const ranked = rankEvidence([lexicalBatch()], { rrfK: 60, fusion: "rrf", exactPrecedence: true });
  const first = paginateRankedEvidence(ranked, undefined, 1, "fictional-fingerprint");
  const second = paginateRankedEvidence(ranked, decodeRetrievalCursor(first.nextCursor!, "fictional-fingerprint", true), 1, "fictional-fingerprint");
  expect([...first.page, ...second.page].map(item => item.memory.id)).toEqual(ranked.map(item => item.memory.id));
  expect(second.nextCursor).toBeNull();
});
