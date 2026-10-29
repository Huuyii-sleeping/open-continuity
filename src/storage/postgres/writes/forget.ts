import { randomUUID } from "node:crypto";
import type { MemoryReceiptLike } from "../../../core/memory/contracts.js";
import { OpenContinuityError } from "../../../shared/errors.js";
import type { PostgresForgetPort } from "../contracts.js";
import { rowToEvent } from "../event-mapping.js";
import { rowToMemory } from "../row-mapping.js";

export async function forgetPostgres(context: PostgresForgetPort, userId: string, agentId: string, memoryId: string, taskId?: string, includePrivate = false): Promise<MemoryReceiptLike> {
  await context.initialize();
  const client = await context.connect();
  let discard = false;
  try {
    await client.query("BEGIN");
    const values: unknown[] = [userId, memoryId, agentId, taskId ?? null, includePrivate];
    const result = await client.query(
      `SELECT * FROM memories_current WHERE user_id = $1 AND id = $2
         AND (scope = 'user' OR (scope = 'agent' AND owner_agent_id = $3) OR (scope = 'task' AND $4::text IS NOT NULL AND task_id = $4))
         AND ($5::boolean OR sensitivity <> 'private') FOR UPDATE`, values,
    );
    if (!result.rows[0]) throw new OpenContinuityError("MEMORY_NOT_FOUND", "Memory not found", 404, { memoryId });
    const current = rowToMemory(result.rows[0]);
    const eventId = randomUUID();
    const timestamp = new Date().toISOString();
    const eventResult = await client.query(
      `INSERT INTO memory_events (id, user_id, agent_id, event_type, memory_id, memory_key, value, kind, scope, task_id, sensitivity, user_confirmed, idempotency_key, created_at, metadata, memory_version)
         VALUES ($1, $2, $3, 'memory_forgotten', $4, $5, NULL, $6, $7, $8, $9, TRUE, $10, $11, '{}'::jsonb, $12) RETURNING *`,
      [eventId, userId, agentId, memoryId, current.key, current.kind, current.scope, current.taskId ?? null, current.sensitivity, "forget:" + memoryId + ":" + randomUUID(), timestamp, current.version],
    );
    await client.query("DELETE FROM memories_current WHERE user_id = $1 AND id = $2", [userId, memoryId]);
    await client.query("COMMIT");
    return { event: rowToEvent(eventResult.rows[0]), duplicate: false, current };
  } catch (error) {
    if (!await context.rollback(client)) {
      discard = true;
      throw new OpenContinuityError("STORAGE_ERROR", "PostgreSQL transaction recovery failed", 500);
    }
    if (error instanceof OpenContinuityError) throw error;
    throw context.storageError(error);
  } finally { client.release(discard ? true : undefined); }
}
