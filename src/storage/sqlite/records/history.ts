import { type SQLInputValue } from "node:sqlite";
import { storageFingerprint } from "../../../core/memory/storage-contract.js";
import { decodeCursor, encodeCursor } from "../../../core/pagination/cursor.js";
import type { HistoryResult, ParsedHistoryInput } from "../../../shared/types.js";
import type { SqliteRecordContext } from "../contracts.js";
import { rowToEvent } from "../event-mapping.js";

export function historySqlite(context: SqliteRecordContext, input: ParsedHistoryInput): HistoryResult {
  context.assertOpen();
  const fingerprint = storageFingerprint(input, "event");
  const cursor = decodeCursor(input.cursor, "event", fingerprint);
  const values: SQLInputValue[] = [input.userId, input.agentId, input.taskId ?? null, input.taskId ?? null, Number(input.includePrivate)];
  const clauses = [
    "user_id = ?",
    "(scope = 'user' OR (scope = 'agent' AND agent_id = ?) OR (scope = 'task' AND ? IS NOT NULL AND task_id = ?))",
    "(? = 1 OR sensitivity <> 'private')",
  ];
  if (input.memoryId) { clauses.push("memory_id = ?"); values.push(input.memoryId); }
  if (cursor) { clauses.push("(created_at < ? OR (created_at = ? AND id < ?))"); values.push(cursor.timestamp, cursor.timestamp, cursor.id); }
  values.push(input.limit + 1);
  const rows = context.all(`SELECT * FROM memory_events WHERE ${clauses.join(" AND ")} ORDER BY created_at DESC, id DESC LIMIT ?`, values).map(rowToEvent);
  const hasMore = rows.length > input.limit;
  const events = hasMore ? rows.slice(0, input.limit) : rows;
  const last = events.at(-1);
  return { events, nextCursor: hasMore && last ? encodeCursor("event", last.createdAt, last.id, fingerprint) : null };
}
