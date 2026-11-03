import { storageFingerprint } from "../../../core/memory/storage-contract.js";
import { decodeCursor, encodeCursor } from "../../../core/pagination/cursor.js";
import { type ParsedRecallInput, type RecallResult } from "../../../shared/types.js";
import type { InMemoryOperations } from "../contracts.js";

export function listInMemory(context: InMemoryOperations, input: ParsedRecallInput): RecallResult {
  const fingerprint = storageFingerprint(input, "memory");
  const cursor = decodeCursor(input.cursor, "memory", fingerprint);
  const matches = Array.from(context.state.resolved.values()).filter((memory) => {
    if (!context.belongsToUser(memory, input.userId) || !context.isVisible(memory, input.agentId, input.taskId)) return false;
    if (!input.includePrivate && memory.sensitivity === "private") return false;
    if (input.scope && memory.scope !== input.scope) return false;
    if (input.key && memory.key !== input.key) return false;
    if (input.kind && memory.kind !== input.kind) return false;
    return !input.query || (memory.key + " " + JSON.stringify(memory.value)).toLowerCase().includes(input.query.toLowerCase());
  }).sort((left, right) => right.updatedAt.localeCompare(left.updatedAt) || right.id.localeCompare(left.id));
  const afterCursor = cursor ? matches.filter((memory) => memory.updatedAt < cursor.timestamp || (memory.updatedAt === cursor.timestamp && memory.id < cursor.id)) : matches;
  const page = afterCursor.slice(0, input.limit + 1);
  const hasMore = page.length > input.limit;
  const memories = hasMore ? page.slice(0, input.limit) : page;
  const last = memories.at(-1);
  return { memories: structuredClone(memories), nextCursor: hasMore && last ? encodeCursor("memory", last.updatedAt, last.id, fingerprint) : null };
}
