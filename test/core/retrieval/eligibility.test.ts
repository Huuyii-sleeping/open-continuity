import { expect, it } from "vitest";
import { validateCandidateEligibility } from "../../../src/core/retrieval/eligibility.js";
import { recallInputSchema } from "../../../src/shared/types.js";
import { lexicalBatch } from "../../helpers/ranking-route-fixtures.js";
import { routeActor } from "../../helpers/core-route-fixtures.js";
it("candidate eligibility: independently rejects hidden or unconfirmed returned hits", () => {
  const input = recallInputSchema.parse({ ...routeActor, query: "needle" });
  for (const changed of [{ sensitivity: "private" as const }, { userConfirmed: false }, { scope: "agent" as const, ownerAgentId: "fictional-other" }, { scope: "task" as const, taskId: "fictional-other" }]) {
    const batch = lexicalBatch(); batch.hits[0].memory = { ...batch.hits[0].memory, ...changed };
    expect(() => validateCandidateEligibility([batch], input, true)).toThrow(expect.objectContaining({ code: "STORAGE_ERROR" }));
  }
});
