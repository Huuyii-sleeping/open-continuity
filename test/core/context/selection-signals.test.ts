import { expect, it } from "vitest";
import { contextSelectionSignals } from "../../../src/core/context/selection/signals.js";
import { resolveContextPackPolicy } from "../../../src/core/context/contracts.js";
import { contextPackInputSchema } from "../../../src/shared/types.js";
import { routeActor, routeContextPolicy, routeMemory } from "../../helpers/core-route-fixtures.js";
it("selection signals: relevance-only and input fallback add no purpose preference", () => {
  const input = contextPackInputSchema.parse({ ...routeActor, query: "needle", purpose: "coding" });
  const eligible = [{ memory: routeMemory({ retrieval: { score: 0.125, channels: ["full_text"], ranks: { full_text: 1 } } }), inputRank: 1 }];
  const pure = contextSelectionSignals(input, eligible, resolveContextPackPolicy({ ...routeContextPolicy, selectionMode: "relevance_only" }), false);
  expect(pure[0]).toMatchObject({ priority: 0.125, selection: { purposePreference: 0, retrievalScore: 0.125 } });
  const fallback = contextSelectionSignals(input, eligible, resolveContextPackPolicy(routeContextPolicy), true); expect(fallback[0].selection.purposePreference).toBe(0);
});
