import { storageFingerprint } from "../../../core/memory/storage-contract.js";
import { decodeCursor, encodeCursor } from "../../../core/pagination/cursor.js";
import { type HistoryResult, type ParsedHistoryInput } from "../../../shared/types.js";
import type { InMemoryOperations } from "../contracts.js";

export function historyInMemory(context: InMemoryOperations, input: ParsedHistoryInput): HistoryResult {
  const fingerprint = storageFingerprint(input, "event");
  const cursor = decodeCursor(input.cursor, "event", fingerprint);
  const matches = context.state.events.filter((event) => {
    if (event.userId !== input.userId || (input.memoryId && event.memoryId !== input.memoryId)) return false;
    if (!input.includePrivate && event.sensitivity === "private") return false;
    if (event.scope === "agent" && event.agentId !== input.agentId) return false;
    if (event.scope === "task" && (!input.taskId || event.taskId !== input.taskId)) return false;
    return true;
  }).sort((left, right) => right.createdAt.localeCompare(left.createdAt) || right.id.localeCompare(left.id));
  const afterCursor = cursor ? matches.filter((event) => event.createdAt < cursor.timestamp || (event.createdAt === cursor.timestamp && event.id < cursor.id)) : matches;
  const page = afterCursor.slice(0, input.limit + 1);
  const hasMore = page.length > input.limit;
  const events = hasMore ? page.slice(0, input.limit) : page;
  const last = events.at(-1);
  return { events: structuredClone(events), nextCursor: hasMore && last ? encodeCursor("event", last.createdAt, last.id, fingerprint) : null };
}
