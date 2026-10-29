import { expect, it } from "vitest";
import { rememberInMemory } from "../../src/storage/inmemory/writes/remember.js";
import { rememberInputSchema } from "../../src/shared/types.js";
import { inmemoryOperations } from "../helpers/inmemory-port-fixture.js";
it("InMemory Remember: duplicate requests do not add events and receipts cannot mutate stored values", () => {
  const operations = inmemoryOperations(), input = rememberInputSchema.parse({ userId: "fictional-user", agentId: "fictional-writer", key: "fictional-key", value: { fictional: ["needle"] }, kind: "decision", idempotencyKey: "fictional-idem" });
  const first = rememberInMemory(operations, input); first.current.value = "fictional-mutated-receipt";
  const duplicate = rememberInMemory(operations, input); expect(duplicate.duplicate).toBe(true); expect(duplicate.current.value).toEqual(input.value); expect(operations.state.events).toHaveLength(1);
  expect(() => rememberInMemory(operations, { ...input, value: "fictional-different" })).toThrow(expect.objectContaining({ code: "IDEMPOTENCY_CONFLICT" }));
  expect(operations.state.events).toHaveLength(1);
});
