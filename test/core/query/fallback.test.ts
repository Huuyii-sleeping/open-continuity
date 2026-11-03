import { expect, it } from "vitest";
import { queryFallback } from "../../../src/core/query/fallback.js";
import { createQueryPlan } from "../../../src/core/query/planner.js";
import { routeInput, routeQueryPolicy, routeSufficiency } from "../../helpers/core-route-fixtures.js";
it("Query fallback: discloses timeout, history truncation and insufficient evidence independently", () => {
  const plan = createQueryPlan(routeInput(), routeQueryPolicy);
  const result = queryFallback(plan, true, "timeout", { ...routeSufficiency(), status: "partial" });
  expect(result).toEqual({ used: true, reasons: ["history_limit", "timeout", "insufficient_evidence"], mode: "deterministic" });
});
