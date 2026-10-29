import { storageFingerprint } from "../../../core/memory/storage-contract.js";
import { decodeCursor, encodeCursor } from "../../../core/pagination/cursor.js";
import { OpenContinuityError } from "../../../shared/errors.js";
import type { HistoryResult, ParsedHistoryInput } from "../../../shared/types.js";
import type { PostgresRecordContext } from "../contracts.js";
import { rowToEvent } from "../event-mapping.js";

export async function historyPostgres(context: PostgresRecordContext, input: ParsedHistoryInput): Promise<HistoryResult> {
  await context.initialize();
  const fingerprint = storageFingerprint(input, "event");
  const cursor = decodeCursor(input.cursor, "event", fingerprint);
  if (cursor && !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(cursor.id)) throw new OpenContinuityError("VALIDATION_ERROR", "Invalid pagination cursor id", 400);
  const values: unknown[] = [input.userId, input.agentId, input.taskId ?? null, input.includePrivate];
  const clauses = [
    "user_id = $1",
    "(scope = 'user' OR (scope = 'agent' AND agent_id = $2) OR (scope = 'task' AND $3::text IS NOT NULL AND task_id = $3))",
    "($4::boolean OR sensitivity <> 'private')",
  ];
  if (input.memoryId) { values.push(input.memoryId); clauses.push("memory_id = $" + values.length + "::uuid"); }
  if (cursor) { values.push(cursor.timestamp, cursor.id); clauses.push("(created_at < $" + (values.length - 1) + "::timestamptz OR (created_at = $" + (values.length - 1) + "::timestamptz AND id < $" + values.length + "::uuid))"); }
  values.push(input.limit + 1);
  const result = await context.query(`SELECT * FROM memory_events WHERE ${clauses.join(" AND ")} ORDER BY created_at DESC, id DESC LIMIT $${values.length}`, values);
  const rows = result.rows.map(rowToEvent);
  const hasMore = rows.length > input.limit;
  const events = hasMore ? rows.slice(0, input.limit) : rows;
  const last = events.at(-1);
  return { events, nextCursor: hasMore && last ? encodeCursor("event", last.createdAt, last.id, fingerprint) : null };
}
