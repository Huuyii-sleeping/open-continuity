import { expect, it } from "vitest";
import { rememberInMemory } from "../../src/storage/inmemory/writes/remember.js";
import { forgetInMemory } from "../../src/storage/inmemory/writes/forget.js";
import { historyInMemory } from "../../src/storage/inmemory/records/history.js";
import { rememberInputSchema, historyInputSchema } from "../../src/shared/types.js";
import type { InMemoryOperations } from "../../src/storage/inmemory/contracts.js";
it("InMemory operations: ownership, idempotency and forgetting work without a Store class", () => {
  const state: InMemoryOperations["state"] = { events: [], resolved: new Map(), idempotency: new Map(), eventOwners: new Map() };
  const operations: InMemoryOperations = { state, belongsToUser: (memory, userId) => state.eventOwners.get(memory.sourceEventId) === userId, isVisible: memory => memory.scope === "user" };
  const input = rememberInputSchema.parse({ userId: "fictional-a", agentId: "fictional-reader", key: "fictional-key", value: "fictional-value", kind: "decision", idempotencyKey: "fictional-idempotency" });
  const remembered = rememberInMemory(operations, input);
  expect(rememberInMemory(operations, input).duplicate).toBe(true); expect(state.events).toHaveLength(1);
  expect(() => forgetInMemory(operations, "fictional-b", input.agentId, remembered.current.id)).toThrow(expect.objectContaining({ code: "MEMORY_NOT_FOUND" }));
  forgetInMemory(operations, input.userId, input.agentId, remembered.current.id);
  expect(state.resolved.size).toBe(0);
  expect(historyInMemory(operations, historyInputSchema.parse({ userId: "fictional-b", agentId: input.agentId })).events).toEqual([]);
  expect(state.events).toHaveLength(2);
});
