import { randomUUID } from "node:crypto";
import type { MemoryReceiptLike } from "../../../core/memory/contracts.js";
import { evolutionReceipt, evolutionReceiptFromEvent, resolveEvolution } from "../../../core/memory/evolution.js";
import { OpenContinuityError } from "../../../shared/errors.js";
import type { ParsedRememberInput } from "../../../shared/types.js";
import type { SqliteRememberPort } from "../contracts.js";
import { eventSnapshot, rowToEvent } from "../event-mapping.js";
import { scopeIdentity } from "../identity.js";
import { sameRequest } from "../request-equality.js";
import { rowToMemory } from "../row-mapping.js";

export function rememberSqlite(context: SqliteRememberPort, input: ParsedRememberInput): MemoryReceiptLike {
  input = structuredClone(input);
  return context.writeTransaction(() => {
    const duplicate = context.get("SELECT * FROM memory_events WHERE user_id = ? AND idempotency_key = ?", [input.userId, input.idempotencyKey]);
    if (duplicate) {
      if (!sameRequest(duplicate, input)) throw new OpenContinuityError("IDEMPOTENCY_CONFLICT", "Idempotency key was already used for a different request", 409, { idempotencyKey: input.idempotencyKey });
      const event = rowToEvent(duplicate);
      const current = eventSnapshot(duplicate);
      return { event, duplicate: true, current, evolution: evolutionReceiptFromEvent(event, current) };
    }

    const eventId = randomUUID();
    const candidateMemoryId = randomUUID();
    const timestamp = new Date().toISOString();
    const previousRow = context.get(
      "SELECT * FROM memories_current WHERE user_id = ? AND scope = ? AND scope_identity = ? AND memory_key = ?",
      [input.userId, input.scope, scopeIdentity(input), input.key],
    );
    const resolution = resolveEvolution(previousRow ? rowToMemory(previousRow) : undefined, input);
    const current = rowToMemory(context.getRequired(
      `INSERT INTO memories_current (id, user_id, memory_key, value, kind, scope, task_id, owner_agent_id, sensitivity, user_confirmed, source_event_id, source_agent_id, updated_at, version, scope_identity, supersedes_event_id, supersedes_version, confidence, confidence_basis)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (user_id, scope, scope_identity, memory_key) DO UPDATE SET
           value = excluded.value, kind = excluded.kind, task_id = excluded.task_id, owner_agent_id = excluded.owner_agent_id,
           sensitivity = excluded.sensitivity, user_confirmed = excluded.user_confirmed, source_event_id = excluded.source_event_id,
           source_agent_id = excluded.source_agent_id, updated_at = excluded.updated_at, version = excluded.version,
           supersedes_event_id = excluded.supersedes_event_id, supersedes_version = excluded.supersedes_version,
           confidence = excluded.confidence, confidence_basis = excluded.confidence_basis
         RETURNING *`,
      [candidateMemoryId, input.userId, input.key, JSON.stringify(resolution.value), input.kind, input.scope, input.taskId ?? null,
        input.scope === "agent" ? input.agentId : null, input.sensitivity, Number(input.userConfirmed), eventId, input.agentId,
        timestamp, resolution.version, scopeIdentity(input), resolution.supersedes?.eventId ?? null, resolution.supersedes?.version ?? null,
        resolution.confidence?.score ?? null, resolution.confidence?.basis ?? null],
    ));
    const event = rowToEvent(context.getRequired(
      `INSERT INTO memory_events (id, user_id, agent_id, event_type, memory_id, memory_key, value, kind, scope, task_id, sensitivity, user_confirmed, idempotency_key, created_at, metadata, memory_version, input_value, evolution_action, write_mode, expected_version, supersedes_event_id, supersedes_version, confidence, confidence_basis)
         VALUES (?, ?, ?, 'memory_remembered', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING *`,
      [eventId, input.userId, input.agentId, current.id, input.key, JSON.stringify(resolution.value), input.kind, input.scope,
        input.taskId ?? null, input.sensitivity, Number(input.userConfirmed), input.idempotencyKey, timestamp,
        JSON.stringify(input.metadata), current.version, JSON.stringify(input.value), resolution.action, input.writeMode, input.expectedVersion ?? null,
        resolution.supersedes?.eventId ?? null, resolution.supersedes?.version ?? null, resolution.confidence?.score ?? null, resolution.confidence?.basis ?? null],
    ));
    if (input.fact || previousRow?.fact != null) {
      context.writeFact(current.id, event.id, input.fact);
      if (input.fact) { current.fact = input.fact; event.fact = input.fact; }
      else delete current.fact;
    }
    return { event, duplicate: false, current, evolution: evolutionReceipt(input, resolution) };
  });
}
