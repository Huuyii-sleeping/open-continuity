import { OpenContinuityError } from "../../../shared/errors.js";
import type { MemoryEvent } from "../../../shared/types.js";
import { memoryEventSchema } from "../../../shared/types.js";
import type { SqliteWriteContext } from "../contracts.js";
import { scopeIdentity } from "../identity.js";
import { rowToMemory } from "../row-mapping.js";

export function applySqliteEvent(context: SqliteWriteContext, event: MemoryEvent): void {
  event = memoryEventSchema.parse(event);
  if (event.type === "memory_forgotten") {
    const currentRow = context.get("SELECT * FROM memories_current WHERE user_id = ? AND id = ?", [event.userId, event.memoryId]);
    if (!currentRow) throw new OpenContinuityError("VALIDATION_ERROR", "Forgotten memory has no current imported state", 400, { eventId: event.id, memoryId: event.memoryId });
    const current = rowToMemory(currentRow);
    context.run(
      `INSERT INTO memory_events (id, user_id, agent_id, event_type, memory_id, memory_key, value, kind, scope, task_id, sensitivity, user_confirmed, idempotency_key, created_at, metadata, memory_version)
         VALUES (?, ?, ?, 'memory_forgotten', ?, ?, NULL, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [event.id, event.userId, event.agentId, event.memoryId, event.key, event.kind, event.scope, event.taskId ?? null,
      event.sensitivity, Number(event.userConfirmed), event.idempotencyKey, event.createdAt, JSON.stringify(event.metadata), current.version],
    );
    context.run("DELETE FROM memories_current WHERE user_id = ? AND id = ?", [event.userId, event.memoryId]);
    return;
  }

  const previousRow = context.get("SELECT * FROM memories_current WHERE user_id = ? AND scope = ? AND scope_identity = ? AND memory_key = ?",
    [event.userId, event.scope, scopeIdentity({ scope: event.scope, taskId: event.taskId, agentId: event.agentId }), event.key]);
  const inferredVersion = event.memoryVersion ?? (previousRow ? Number(previousRow.version) + 1 : 1);
  const current = rowToMemory(context.getRequired(
    `INSERT INTO memories_current (id, user_id, memory_key, value, kind, scope, task_id, owner_agent_id, sensitivity, user_confirmed, source_event_id, source_agent_id, updated_at, version, scope_identity, supersedes_event_id, supersedes_version, confidence, confidence_basis)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (user_id, scope, scope_identity, memory_key) DO UPDATE SET
         id = excluded.id, value = excluded.value, kind = excluded.kind, task_id = excluded.task_id, owner_agent_id = excluded.owner_agent_id,
         sensitivity = excluded.sensitivity, user_confirmed = excluded.user_confirmed, source_event_id = excluded.source_event_id,
         source_agent_id = excluded.source_agent_id, updated_at = excluded.updated_at, version = excluded.version,
         supersedes_event_id = excluded.supersedes_event_id, supersedes_version = excluded.supersedes_version, confidence = excluded.confidence, confidence_basis = excluded.confidence_basis
       RETURNING *`,
    [event.memoryId, event.userId, event.key, JSON.stringify(event.value), event.kind, event.scope, event.taskId ?? null,
    event.scope === "agent" ? event.agentId : null, event.sensitivity, Number(event.userConfirmed), event.id, event.agentId,
    event.createdAt, inferredVersion, scopeIdentity({ scope: event.scope, taskId: event.taskId, agentId: event.agentId }),
    event.supersedes?.eventId ?? null, event.supersedes?.version ?? null, event.confidence?.score ?? null, event.confidence?.basis ?? null],
  ));
  context.run(
    `INSERT INTO memory_events (id, user_id, agent_id, event_type, memory_id, memory_key, value, kind, scope, task_id, sensitivity, user_confirmed, idempotency_key, created_at, metadata, memory_version, input_value, evolution_action, write_mode, expected_version, supersedes_event_id, supersedes_version, confidence, confidence_basis)
       VALUES (?, ?, ?, 'memory_remembered', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [event.id, event.userId, event.agentId, current.id, event.key, JSON.stringify(event.value), event.kind, event.scope,
    event.taskId ?? null, event.sensitivity, Number(event.userConfirmed), event.idempotencyKey, event.createdAt,
    JSON.stringify(event.metadata), current.version, event.inputValue === undefined ? null : JSON.stringify(event.inputValue), event.evolutionAction ?? null, event.writeMode ?? null,
    event.expectedVersion ?? null, event.supersedes?.eventId ?? null, event.supersedes?.version ?? null, event.confidence?.score ?? null, event.confidence?.basis ?? null],
  );
  if (event.fact || previousRow?.fact != null) context.writeFact(current.id, event.id, event.fact);
}
