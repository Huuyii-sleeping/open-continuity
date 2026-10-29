import { expect, it } from "vitest";
import { eligibleContextMemories } from "../../../src/core/context/selection/eligibility.js";
import { resolveContextPackPolicy } from "../../../src/core/context/contracts.js";
import { contextPackInputSchema } from "../../../src/shared/types.js";
import { routeActor, routeContextPolicy, routeMemory } from "../../helpers/core-route-fixtures.js";
it("selection eligibility: confirmation is a filter and never a ranking boost", () => {
  const result = eligibleContextMemories(contextPackInputSchema.parse({ ...routeActor, query: "needle" }), [routeMemory({ userConfirmed: false }), routeMemory({ id: "fictional-approved" })], resolveContextPackPolicy(routeContextPolicy));
  expect(result).toMatchObject([{ memory: { id: "fictional-approved" }, inputRank: 2 }]);
});
it("selection eligibility: rejects private or wrong-scope provider output before ordering", () => {
  const input = contextPackInputSchema.parse({ ...routeActor, query: "needle" }), policy = resolveContextPackPolicy(routeContextPolicy);
  for (const memory of [routeMemory({ sensitivity: "private" }), routeMemory({ scope: "agent", ownerAgentId: "fictional-other" }), routeMemory({ scope: "task", taskId: "fictional-other-task" })]) expect(() => eligibleContextMemories(input, [memory], policy)).toThrow(expect.objectContaining({ code: "STORAGE_ERROR" }));
});
