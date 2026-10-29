import { expect, it } from "vitest";
import { orderByInput } from "../../../src/core/context/selection/input-order.js";
import { routeCandidate } from "../../helpers/core-route-fixtures.js";
it("input-order fallback: preserves upstream position despite purpose, recency and priority", () => {
  const first = routeCandidate({ id: "fictional-first", updatedAt: "2030-01-01T00:00:00Z" }), second = routeCandidate({ id: "fictional-second", updatedAt: "2033-01-01T00:00:00Z" });
  first.selection.inputRank = 1; first.priority = 0; second.selection.inputRank = 2; second.priority = 999; second.selection.purposePreference = 12;
  const candidates = [second, first]; orderByInput(candidates); expect(candidates.map(item => item.memory.id)).toEqual([first.memory.id, second.memory.id]);
});
