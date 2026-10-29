import { matchesFactGroup, parseFactGroupRequest, type FactGroupRequest } from "../../../core/facts/contracts.js";
import type { InMemoryOperations } from "../contracts.js";

export function factGroupInMemory(context: InMemoryOperations, request: FactGroupRequest) {
  const input = parseFactGroupRequest(request);
  const rows = Array.from(context.state.resolved.values()).filter(memory => context.belongsToUser(memory, input.userId)
    && context.isVisible(memory, input.agentId, input.taskId) && matchesFactGroup(memory, input))
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt) || b.id.localeCompare(a.id));
  return { memories: structuredClone(rows.slice(0, input.limit)), truncated: rows.length > input.limit };
}
