import { expect, it } from "vitest";
import { rememberInMemory } from "../../src/storage/inmemory/writes/remember.js";
import { forgetInMemory } from "../../src/storage/inmemory/writes/forget.js";
import { historyInMemory } from "../../src/storage/inmemory/records/history.js";
import { rememberInputSchema, historyInputSchema } from "../../src/shared/types.js";
import { inmemoryOperations } from "../helpers/inmemory-port-fixture.js";
it("InMemory history: retains owned audit evidence after forgetting without cross-user disclosure", () => {
  const operations = inmemoryOperations(), actor = { userId: "fictional-user", agentId: "fictional-reader" };
  const created = rememberInMemory(operations, rememberInputSchema.parse({ ...actor, key: "fictional-key", value: "fictional value", kind: "decision", idempotencyKey: "fictional-idem" }));
  forgetInMemory(operations, actor.userId, actor.agentId, created.current.id);
  expect(historyInMemory(operations, historyInputSchema.parse(actor)).events).toHaveLength(2);
  expect(historyInMemory(operations, historyInputSchema.parse({ ...actor, userId: "fictional-other" })).events).toEqual([]);
});
