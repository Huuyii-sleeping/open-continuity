import { expect, it } from "vitest";
import { assessQuerySufficiency } from "../../../src/core/query/sufficiency.js";
import { createQueryPlan } from "../../../src/core/query/planner.js";
import { routeInput, routeQueryPolicy, routeEvidence } from "../../helpers/core-route-fixtures.js";
it("sufficiency: missing obligations or unsupported reasoning cannot be called sufficient", () => {
  const input = { ...routeInput(), subqueries: ["needle", "fictional missing"], strategy: "multi_step" as const };
  const plan = createQueryPlan(input, routeQueryPolicy);
  expect(assessQuerySufficiency(input, plan, [routeEvidence()], 1, "completed", 0, false)).toMatchObject({ status: "partial", totalQueries: 2 });
  expect(assessQuerySufficiency(input, { ...plan, unsupportedComplexity: true }, [routeEvidence()], 2, "completed", 0, false).status).toBe("partial");
});
it("sufficiency: an empty budgeted evidence set is insufficient", () => {
  const input = routeInput();
  expect(assessQuerySufficiency(input, createQueryPlan(input, routeQueryPolicy), [], 0, "completed", 0, false)).toMatchObject({ status: "insufficient", evidenceCount: 0 });
});
