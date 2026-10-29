import { expect, it, vi } from "vitest";
import { composeQueryResponse } from "../../../src/core/query/response.js";
import { createQueryPlan } from "../../../src/core/query/planner.js";
import { ContextPackBuilder } from "../../../src/core/context/pack.js";
import { ReadDeadline } from "../../../src/core/runtime/deadline.js";
import { routeInput, routeEvidence, routeQueryPolicy, routeContextPolicy } from "../../helpers/core-route-fixtures.js";
it("response: an expired shared budget clears context and produces abstention without new I/O", () => {
  const recall = vi.fn(), builder = new ContextPackBuilder({ recall }, routeContextPolicy);
  const budget = new ReadDeadline(10, () => 0); budget.stop();
  const input = routeInput();
  const response = composeQueryResponse(builder, builder.capabilityPolicy(), input, createQueryPlan(input, routeQueryPolicy), [routeEvidence()], [], false, false, [], budget, "completed");
  expect(response).toMatchObject({ stoppedReason: "timeout", contextPack: { items: [] }, answer: { status: "abstain", statements: [] }, sufficiency: { status: "insufficient" } });
  expect(recall).not.toHaveBeenCalled();
});
it("response: accepts a narrow packer and drops an answer that finishes after the shared deadline", () => {
  let now = 0; const budget = new ReadDeadline(10, () => now), input = routeInput();
  const builder = new ContextPackBuilder({ recall: vi.fn() }, routeContextPolicy);
  const packer = { buildFromMemories: vi.fn<typeof builder.buildFromMemories>((...args) => { const pack = builder.buildFromMemories(...args); now = 11; return pack; }) };
  const response = composeQueryResponse(packer, builder.capabilityPolicy(), input, createQueryPlan(input, routeQueryPolicy), [routeEvidence()], [], false, false, [], budget, "completed");
  expect(response.answer.status).toBe("abstain"); expect(response.contextPack.items).toEqual([]); expect(response.stoppedReason).toBe("timeout");
});
