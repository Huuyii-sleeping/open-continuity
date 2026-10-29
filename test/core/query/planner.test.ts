import { expect, it } from "vitest";
import { createQueryPlan } from "../../../src/core/query/planner.js";
import { routeInput, routeQueryPolicy } from "../../helpers/core-route-fixtures.js";
it("planner: preserves requested obligations when execution subqueries are bounded", () => {
  const input = { ...routeInput(), strategy: "multi_step" as const, subqueries: ["fictional alpha", "fictional beta"] };
  const plan = createQueryPlan(input, { ...routeQueryPolicy, maxSubqueries: 1 });
  expect(plan).toMatchObject({ queries: ["fictional alpha"], requestedQueries: ["fictional alpha", "fictional beta"], totalQueries: 2, subqueryLimitApplied: true });
});
it("planner: direct requests do not silently expand into history work", () => {
  const plan = createQueryPlan({ ...routeInput(), strategy: "direct", includeHistory: true }, routeQueryPolicy);
  expect(plan.historyRequested).toBe(false); expect(plan.steps.map(step => step.type)).toEqual(["recall"]);
  expect(plan.rationale).toContain("history_signal_ignored_by_direct_strategy");
});
