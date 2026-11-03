import type { MemoryEvent } from "../../../shared/types.js";
import type { SqliteRecordContext } from "../contracts.js";
import { rowToEvent } from "../event-mapping.js";

export function exportSqliteEvents(context: SqliteRecordContext): MemoryEvent[] {
  context.assertOpen();
  return context.all("SELECT * FROM memory_events ORDER BY rowid ASC", []).map(rowToEvent);
}
