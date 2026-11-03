import { expect, it } from "vitest";
import { assessBudgetedQuery } from "../../../src/core/query/budgeted-sufficiency.js";
import { createQueryPlan } from "../../../src/core/query/planner.js";
import { routeInput, routeQueryPolicy, routeEvidence } from "../../helpers/core-route-fixtures.js";
it("budgeted sufficiency: retrieved evidence does not imply an answer when packing omitted it", () => {
  const input = routeInput(), plan = createQueryPlan(input, routeQueryPolicy);
  const result = assessBudgetedQuery(input, plan, [routeEvidence()], [], 0, "completed", false, false, []);
  expect(result.status).toBe("insufficient"); expect(result.reasons).toContain("empty_context"); expect(result.reasons).toContain("context_budget");
});
it("budgeted sufficiency: a truncated candidate set retains partial status despite covered queries", () => {
  const input = routeInput(), plan = createQueryPlan(input, routeQueryPolicy), evidence = [routeEvidence()];
  const result = assessBudgetedQuery(input, plan, evidence, evidence, 1, "completed", false, true, []);
  expect(result.status).toBe("partial"); expect(result.reasons).toContain("candidate_limit");
});
