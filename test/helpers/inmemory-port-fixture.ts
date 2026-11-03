import type { InMemoryOperations } from "../../src/storage/inmemory/contracts.js";
export function inmemoryOperations(): InMemoryOperations {
  const state: InMemoryOperations["state"] = { events: [], resolved: new Map(), idempotency: new Map(), eventOwners: new Map() };
  return { state, belongsToUser: (memory, userId) => state.eventOwners.get(memory.sourceEventId) === userId,
    isVisible: (memory, agentId, taskId) => memory.scope === "user" || (memory.scope === "agent" && memory.ownerAgentId === agentId) || (memory.scope === "task" && Boolean(taskId) && memory.taskId === taskId) };
}
