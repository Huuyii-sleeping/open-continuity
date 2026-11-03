import { expect, it } from "vitest";
import { validateAnswerEvidence } from "../../../src/core/answer/validation.js";
import { routeEvidence, routePack, routeSufficiency } from "../../helpers/core-route-fixtures.js";
it("answer validation: rejects forged coverage counts and mismatched sufficiency", () => {
  const pack = routePack(); pack.coverage!.requirements[0].retrievedCount = 2;
  expect(() => validateAnswerEvidence(pack, [routeEvidence()], routeSufficiency())).toThrow(expect.objectContaining({ code: "STORAGE_ERROR" }));
  expect(() => validateAnswerEvidence(routePack(), [routeEvidence()], { ...routeSufficiency(), evidenceCount: 2 })).toThrow(expect.objectContaining({ code: "STORAGE_ERROR" }));
});
