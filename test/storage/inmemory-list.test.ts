import { expect, it } from "vitest";
import { listInMemory } from "../../src/storage/inmemory/records/list.js";
import { rememberInMemory } from "../../src/storage/inmemory/writes/remember.js";
import { rememberInputSchema, recallInputSchema } from "../../src/shared/types.js";
import { inmemoryOperations } from "../helpers/inmemory-port-fixture.js";
it("InMemory list: applies actor scope before paging and forbids cursor reuse under another identity", () => {
  const operations = inmemoryOperations(), actor = { userId: "fictional-user", agentId: "fictional-reader" };
  for (let index = 0; index < 3; index++) rememberInMemory(operations, rememberInputSchema.parse({ ...actor, key: "fictional-key-" + index, value: "fictional value", kind: "decision", idempotencyKey: "fictional-idem-" + index }));
  rememberInMemory(operations, rememberInputSchema.parse({ ...actor, agentId: "fictional-other", scope: "agent", key: "fictional-hidden", value: "fictional value", kind: "decision", idempotencyKey: "fictional-hidden-idem" }));
  const input = recallInputSchema.parse({ ...actor, limit: 1 }), first = listInMemory(operations, input);
  const remaining = listInMemory(operations, { ...input, cursor: first.nextCursor!, limit: 100 });
  expect(new Set([...first.memories, ...remaining.memories].map(memory => memory.id)).size).toBe(3);
  expect(() => listInMemory(operations, { ...input, userId: "fictional-other-user", cursor: first.nextCursor! })).toThrow(expect.objectContaining({ code: "VALIDATION_ERROR" }));
});
