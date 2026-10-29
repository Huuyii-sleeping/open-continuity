import { expect, it } from "vitest";
import { rememberInMemory } from "../../src/storage/inmemory/writes/remember.js";
import { forgetInMemory } from "../../src/storage/inmemory/writes/forget.js";
import { rememberInputSchema } from "../../src/shared/types.js";
import { inmemoryOperations } from "../helpers/inmemory-port-fixture.js";
it("InMemory Forget: hidden private records cannot be deleted without permission", () => {
  const operations = inmemoryOperations(), input = rememberInputSchema.parse({ userId: "fictional-user", agentId: "fictional-writer", key: "fictional-key", value: "fictional value", kind: "decision", sensitivity: "private", idempotencyKey: "fictional-idem" });
  const created = rememberInMemory(operations, input);
  expect(() => forgetInMemory(operations, input.userId, input.agentId, created.current.id)).toThrow(expect.objectContaining({ code: "MEMORY_NOT_FOUND" }));
  expect(operations.state.events).toHaveLength(1);
  forgetInMemory(operations, input.userId, input.agentId, created.current.id, undefined, true); expect(operations.state.resolved.size).toBe(0); expect(operations.state.events).toHaveLength(2);
});
