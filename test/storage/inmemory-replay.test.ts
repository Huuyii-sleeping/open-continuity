import { expect, it } from "vitest";
import { rememberInMemory } from "../../src/storage/inmemory/writes/remember.js";
import { replayInMemoryEvent } from "../../src/storage/inmemory/events/replay.js";
import { rememberInputSchema } from "../../src/shared/types.js";
import { inmemoryOperations } from "../helpers/inmemory-port-fixture.js";
it("InMemory event replay: restores version state and rejects duplicate identity before mutation", () => {
  const source = inmemoryOperations(), target = inmemoryOperations();
  const original = rememberInMemory(source, rememberInputSchema.parse({ userId: "fictional-user", agentId: "fictional-reader", key: "fictional-key", value: "fictional value", kind: "decision", idempotencyKey: "fictional-idem" }));
  replayInMemoryEvent(target, original.event); expect([...target.state.resolved.values()][0]).toEqual(original.current);
  expect(() => replayInMemoryEvent(target, original.event)).toThrow(expect.objectContaining({ code: "STORAGE_ERROR" })); expect(target.state.events).toHaveLength(1);
});
