import { expect, it } from "vitest";
import { orderByLegacyWeight } from "../../../src/core/context/selection/legacy.js";
import { routeCandidate } from "../../helpers/core-route-fixtures.js";
it("legacy selection: only its explicit weight order can override the relevance order", () => {
  const heavy = routeCandidate({ id: "fictional-heavy" }), exact = routeCandidate({ id: "fictional-exact" });
  heavy.priority = 100; exact.priority = 10; exact.selection.exactTier = 1;
  const candidates = [exact, heavy]; orderByLegacyWeight(candidates); expect(candidates.map(item => item.memory.id)).toEqual([heavy.memory.id, exact.memory.id]);
});
