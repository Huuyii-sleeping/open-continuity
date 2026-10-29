import { randomUUID } from "node:crypto";
import type { MemoryReceiptLike } from "../../../core/memory/contracts.js";
import { OpenContinuityError } from "../../../shared/errors.js";
import type { SqliteForgetPort } from "../contracts.js";
import { rowToEvent } from "../event-mapping.js";
import { rowToMemory } from "../row-mapping.js";

export function forgetSqlite(context: SqliteForgetPort, userId: string, agentId: string, memoryId: string, taskId?: string, includePrivate = false): MemoryReceiptLike {
  return context.writeTransaction(() => {
    const row = context.get(
      `SELECT * FROM memories_current WHERE user_id = ? AND id = ?
         AND (scope = 'user' OR (scope = 'agent' AND owner_agent_id = ?) OR (scope = 'task' AND ? IS NOT NULL AND task_id = ?))
         AND (? = 1 OR sensitivity <> 'private')`,
      [userId, memoryId, agentId, taskId ?? null, taskId ?? null, Number(includePrivate)],
    );
    if (!row) throw new OpenContinuityError("MEMORY_NOT_FOUND", "Memory not found", 404, { memoryId });
    const current = rowToMemory(row);
    const eventId = randomUUID();
    const timestamp = new Date().toISOString();
    const event = rowToEvent(context.getRequired(
      `INSERT INTO memory_events (id, user_id, agent_id, event_type, memory_id, memory_key, value, kind, scope, task_id, sensitivity, user_confirmed, idempotency_key, created_at, metadata, memory_version)
         VALUES (?, ?, ?, 'memory_forgotten', ?, ?, NULL, ?, ?, ?, ?, 1, ?, ?, '{}', ?) RETURNING *`,
      [eventId, userId, agentId, memoryId, current.key, current.kind, current.scope, current.taskId ?? null,
        current.sensitivity, `forget:${memoryId}:${randomUUID()}`, timestamp, current.version],
    ));
    context.run("DELETE FROM memories_current WHERE user_id = ? AND id = ?", [userId, memoryId]);
    return { event, duplicate: false, current };
  });
}
