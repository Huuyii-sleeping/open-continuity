import { type SQLInputValue } from "node:sqlite";
import type { MemoryEvent } from "../../../shared/types.js";
import type { SqliteRecordContext } from "../contracts.js";
import { rowToEvent } from "../event-mapping.js";

export function inspectSqliteHistory(context: SqliteRecordContext, input: { userId: string; memoryId?: string; includePrivate?: boolean; limit?: number }): MemoryEvent[] {
  context.assertOpen();
  const clauses = ["user_id = ?", "(? = 1 OR sensitivity <> 'private')"];
  const values: SQLInputValue[] = [input.userId, Number(input.includePrivate ?? true)];
  if (input.memoryId) { clauses.push("memory_id = ?"); values.push(input.memoryId); }
  values.push(input.limit ?? 100);
  return context.all(`SELECT * FROM memory_events WHERE ${clauses.join(" AND ")} ORDER BY created_at DESC, id DESC LIMIT ?`, values).map(rowToEvent);
}
