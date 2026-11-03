import { expect, it } from "vitest";
import { createPackingState } from "../../../src/core/context/packing/budget.js";
import { packByCoverage } from "../../../src/core/context/packing/coverage.js";
import { packByRank } from "../../../src/core/context/packing/rank.js";
import { routeCandidate } from "../../helpers/core-route-fixtures.js";
it("coverage packing: chooses broad coverage first, then fills by rank without duplicate charging", () => {
  const candidates = [routeCandidate({ id: "fictional-first" }), routeCandidate({ id: "fictional-broad" }), routeCandidate({ id: "fictional-third" })];
  const requirements = [{ id: "a", query: "fictional-a", memoryIds: ["fictional-first", "fictional-broad"] }, { id: "b", query: "fictional-b", memoryIds: ["fictional-broad", "fictional-third"] }];
  const state = createPackingState(4096, 2);
  packByCoverage(candidates, requirements, state); packByRank(candidates, state);
  expect(state.items.map(item => item.memoryId)).toEqual(["fictional-broad", "fictional-first"]);
  expect(state.accepted.size).toBe(2);
  expect(state.omitted).toMatchObject([{ memoryId: "fictional-third", reason: "max_memories" }]);
});
