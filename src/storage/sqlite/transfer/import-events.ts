import { OpenContinuityError } from "../../../shared/errors.js";
import type { MemoryEvent } from "../../../shared/types.js";
import type { SqliteWriteContext } from "../contracts.js";

export function importSqliteEvents(context: SqliteWriteContext, events: MemoryEvent[]): void {
  context.writeTransaction(() => {
    const count = context.getRequired("SELECT COUNT(*) AS count FROM memory_events", []);
    if (Number(count.count) !== 0) throw new OpenContinuityError("STORAGE_ERROR", "SQLite import target must be empty", 409);
    for (const event of events) context.importEvent(event);
  });
}
