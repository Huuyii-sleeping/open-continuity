import { storageFingerprint } from "../../../core/memory/storage-contract.js";
import { decodeCursor, encodeCursor } from "../../../core/pagination/cursor.js";
import { OpenContinuityError } from "../../../shared/errors.js";
import type { ParsedRecallInput, RecallResult } from "../../../shared/types.js";
import type { PostgresRecordContext } from "../contracts.js";
import { rowToMemory } from "../row-mapping.js";

export async function listPostgres(context: PostgresRecordContext, input: ParsedRecallInput): Promise<RecallResult> {
  await context.initialize();
  const fingerprint = storageFingerprint(input, "memory");
  const cursor = decodeCursor(input.cursor, "memory", fingerprint);
  if (cursor && !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(cursor.id)) throw new OpenContinuityError("VALIDATION_ERROR", "Invalid pagination cursor id", 400);
  const values: unknown[] = [input.userId, input.agentId, input.taskId ?? null, input.includePrivate];
  const clauses = [
    "user_id = $1",
    "(scope = 'user' OR (scope = 'agent' AND owner_agent_id = $2) OR (scope = 'task' AND $3::text IS NOT NULL AND task_id = $3))",
    "($4::boolean OR sensitivity <> 'private')",
  ];
  const add = (clause: string, value: unknown) => { values.push(value); clauses.push(clause.replace("?", "$" + values.length)); };
  if (input.scope) add("scope = ?", input.scope);
  if (input.key) add("memory_key = ?", input.key);
  if (input.kind) add("kind = ?", input.kind);
  if (input.query) {
    values.push(input.query);
    clauses.push(`(strpos(lower(memory_key), lower($${values.length}::text)) > 0 OR strpos(lower(value::text), lower($${values.length}::text)) > 0)`);
  }
  if (cursor) { values.push(cursor.timestamp, cursor.id); clauses.push("(updated_at < $" + (values.length - 1) + "::timestamptz OR (updated_at = $" + (values.length - 1) + "::timestamptz AND id < $" + values.length + "::uuid))"); }
  values.push(input.limit + 1);
  const result = await context.query(`SELECT * FROM memories_current WHERE ${clauses.join(" AND ")} ORDER BY updated_at DESC, id DESC LIMIT $${values.length}`, values);
  const rows = result.rows.map(rowToMemory);
  const hasMore = rows.length > input.limit;
  const memories = hasMore ? rows.slice(0, input.limit) : rows;
  const last = memories.at(-1);
  return { memories, nextCursor: hasMore && last ? encodeCursor("memory", last.updatedAt, last.id, fingerprint) : null };
}
