import { expect, it } from "vitest";
import { resolveEvolution } from "../../../src/core/memory/evolution.js";
import { memoryFactSchema, rememberInputSchema } from "../../../src/shared/types.js";
import { routeActor, routeMemory } from "../../helpers/core-route-fixtures.js";
it("evolution: CAS conflicts fail before replacement or merge", () => {
  const input = rememberInputSchema.parse({ ...routeActor, key: "fictional-key", value: { fictional: true }, kind: "decision", idempotencyKey: "fictional-idem", expectedVersion: 1, writeMode: "merge" });
  expect(() => resolveEvolution(routeMemory({ version: 2 }), input)).toThrow(expect.objectContaining({ code: "VERSION_CONFLICT" }));
});
it("evolution: removing an existing explicit declaration still requires approval and CAS", () => {
  const input = rememberInputSchema.parse({ ...routeActor, key: "fictional-key", value: "fictional replacement", kind: "decision", idempotencyKey: "fictional-idem" });
  expect(() => resolveEvolution(routeMemory({ fact: memoryFactSchema.parse({ group: "fictional-group" }) }), input)).toThrow(expect.objectContaining({ code: "VALIDATION_ERROR" }));
});
