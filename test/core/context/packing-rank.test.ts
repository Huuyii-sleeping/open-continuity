import { expect, it } from "vitest";
import { createPackingState } from "../../../src/core/context/packing/budget.js";
import { packByRank } from "../../../src/core/context/packing/rank.js";
import { routeCandidate } from "../../helpers/core-route-fixtures.js";
it("rank packing: skips an oversized value and retains the next complete candidate", () => {
  const state = createPackingState(128, 2);
  packByRank([routeCandidate({ id: "fictional-large", value: "fictional ".repeat(2000) }), routeCandidate()], state);
  expect(state.items.map(item => item.memoryId)).toEqual([routeCandidate().memory.id]);
  expect(state.omitted[0].reason).toBe("token_budget");
  expect(state.items[0].value).toBe("fictional needle");
});
