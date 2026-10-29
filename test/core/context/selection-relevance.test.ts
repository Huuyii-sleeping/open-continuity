import { expect, it } from "vitest";
import { orderByRelevance } from "../../../src/core/context/selection/relevance.js";
import { routeCandidate } from "../../helpers/core-route-fixtures.js";
it("relevance selection: exact tier and relevance precede purpose and recency", () => {
  const exact = routeCandidate({ id: "fictional-exact", updatedAt: "2030-01-01T00:00:00Z" });
  exact.selection.exactTier = 1; exact.selection.retrievalScore = 0.01;
  const relevant = routeCandidate({ id: "fictional-relevant" }); relevant.selection.retrievalScore = 2;
  const preferred = routeCandidate({ id: "fictional-preferred", updatedAt: "2032-01-01T00:00:00Z" }); preferred.selection.purposePreference = 12;
  const candidates = [preferred, relevant, exact]; orderByRelevance(candidates);
  expect(candidates.map(item => item.memory.id)).toEqual([exact.memory.id, relevant.memory.id, preferred.memory.id]);
});
it("relevance selection: updatedAt and id break equal score and purpose ties", () => {
  const left = routeCandidate({ id: "fictional-a" }), right = routeCandidate({ id: "fictional-z" });
  const candidates = [left, right]; orderByRelevance(candidates); expect(candidates.map(item => item.memory.id)).toEqual([right.memory.id, left.memory.id]);
});
