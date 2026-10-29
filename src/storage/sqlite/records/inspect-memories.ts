import { type SQLInputValue } from "node:sqlite";
import type { MemoryKind, ResolvedMemory } from "../../../shared/types.js";
import type { SqliteRecordContext } from "../contracts.js";
import { rowToMemory } from "../row-mapping.js";

export function inspectSqliteMemories(context: SqliteRecordContext, input: { userId: string; memoryId?: string; query?: string; kind?: MemoryKind; includePrivate?: boolean; limit?: number }): ResolvedMemory[] {
  context.assertOpen();
  const clauses = ["user_id = ?", "(? = 1 OR sensitivity <> 'private')"];
  const values: SQLInputValue[] = [input.userId, Number(input.includePrivate ?? true)];
  if (input.memoryId) { clauses.push("id = ?"); values.push(input.memoryId); }
  if (input.kind) { clauses.push("kind = ?"); values.push(input.kind); }
  if (input.query) { clauses.push("(instr(lower(memory_key), lower(?)) > 0 OR instr(lower(value), lower(?)) > 0)"); values.push(input.query, input.query); }
  values.push(input.limit ?? 20);
  return context.all(`SELECT * FROM memories_current WHERE ${clauses.join(" AND ")} ORDER BY updated_at DESC, id DESC LIMIT ?`, values).map(rowToMemory);
}
