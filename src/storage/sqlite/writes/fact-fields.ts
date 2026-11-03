import { memoryFactSchema, type MemoryFact } from "../../../shared/types.js";
import type { SqliteWriteContext } from "../contracts.js";

export function writeSqliteFact(context: SqliteWriteContext, memoryId: string, eventId: string, fact?: MemoryFact): void {
  if (fact) memoryFactSchema.parse(fact);
  const value = fact ? JSON.stringify(fact) : null;
  context.run("UPDATE memories_current SET fact = ?, fact_group = ? WHERE id = ?", [value, fact?.group ?? null, memoryId]);
  context.run("UPDATE memory_events SET fact = ? WHERE id = ?", [value, eventId]);
}
