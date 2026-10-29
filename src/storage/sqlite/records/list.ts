import type { SQLInputValue } from "node:sqlite";
import { storageFingerprint } from "../../../core/memory/storage-contract.js";
import { decodeCursor, encodeCursor } from "../../../core/pagination/cursor.js";
import type { ParsedRecallInput, RecallResult } from "../../../shared/types.js";
import type { SqliteRecordContext } from "../contracts.js";
import { ftsPhrase } from "../readers/fts.js";
import { rowToMemory } from "../row-mapping.js";
export function listSqlite(context: SqliteRecordContext, input: ParsedRecallInput): RecallResult {
  context.assertOpen();
  const fingerprint = storageFingerprint(input, "memory");
  const cursor = decodeCursor(input.cursor, "memory", fingerprint);
  const values: SQLInputValue[] = [input.userId, input.agentId, input.taskId ?? null, input.taskId ?? null, Number(input.includePrivate)];
  const clauses = [
    "user_id = ?",
    "(scope = 'user' OR (scope = 'agent' AND owner_agent_id = ?) OR (scope = 'task' AND ? IS NOT NULL AND task_id = ?))",
    "(? = 1 OR sensitivity <> 'private')",
  ];
  const add = (clause: string, value: SQLInputValue) => { clauses.push(clause); values.push(value); };
  if (input.scope) add("scope = ?", input.scope);
  if (input.key) add("memory_key = ?", input.key);
  if (input.kind) add("kind = ?", input.kind);
  if (input.query) {
    if ([...input.query].length >= 3) add("id IN (SELECT memory_id FROM memories_fts WHERE memories_fts MATCH ?)", ftsPhrase(input.query));
    else { clauses.push("(instr(lower(memory_key), lower(?)) > 0 OR instr(lower(value), lower(?)) > 0)"); values.push(input.query, input.query); }
  }
  if (cursor) { clauses.push("(updated_at < ? OR (updated_at = ? AND id < ?))"); values.push(cursor.timestamp, cursor.timestamp, cursor.id); }
  values.push(input.limit + 1);
  const rows = context.all(`SELECT * FROM memories_current WHERE ${clauses.join(" AND ")} ORDER BY updated_at DESC, id DESC LIMIT ?`, values).map(rowToMemory);
  const hasMore = rows.length > input.limit;
  const memories = hasMore ? rows.slice(0, input.limit) : rows;
  const last = memories.at(-1);
  return { memories, nextCursor: hasMore && last ? encodeCursor("memory", last.updatedAt, last.id, fingerprint) : null };
}
