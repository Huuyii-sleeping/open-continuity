import type { QueryResultRow } from "pg";
import type { MemoryEvent, ResolvedMemory } from "../../shared/types.js";
import { memoryFactSchema } from "../../shared/types.js";
export function iso(value: unknown): string {
  return value instanceof Date ? value.toISOString() : new Date(String(value)).toISOString();
}
export function rowToEvent(row: QueryResultRow): MemoryEvent {
  const event: MemoryEvent = {
    id: row.id, userId: row.user_id, agentId: row.agent_id, type: row.event_type, memoryId: row.memory_id,
    key: row.memory_key, kind: row.kind, scope: row.scope, taskId: row.task_id ?? undefined, sensitivity: row.sensitivity,
    userConfirmed: row.user_confirmed, idempotencyKey: row.idempotency_key, createdAt: iso(row.created_at), metadata: structuredClone(row.metadata ?? {}), memoryVersion: row.memory_version,
  };
  if (row.event_type === "memory_remembered") event.value = structuredClone(row.value);
  if (row.event_type === "memory_remembered") {
    if (row.input_value != null) event.inputValue = structuredClone(row.input_value);
    if (row.evolution_action != null) event.evolutionAction = row.evolution_action;
    if (row.write_mode != null) event.writeMode = row.write_mode;
    if (row.expected_version != null) event.expectedVersion = row.expected_version;
    if (row.supersedes_event_id != null && row.supersedes_version != null) event.supersedes = { eventId: row.supersedes_event_id, version: row.supersedes_version };
    if (row.confidence != null && row.confidence_basis != null) event.confidence = { score: Number(row.confidence), basis: row.confidence_basis };
  }
  if (row.fact != null) event.fact = memoryFactSchema.parse(row.fact);
  return event;
}
export function eventSnapshot(row: QueryResultRow): ResolvedMemory {
  const memory: ResolvedMemory = {
    id: row.memory_id, key: row.memory_key, value: structuredClone(row.value), kind: row.kind, scope: row.scope, taskId: row.task_id ?? undefined,
    ownerAgentId: row.scope === "agent" ? row.agent_id : undefined, sensitivity: row.sensitivity, userConfirmed: row.user_confirmed,
    sourceEventId: row.id, sourceAgentId: row.agent_id, updatedAt: iso(row.created_at), version: row.memory_version,
  };
  if (row.supersedes_event_id != null && row.supersedes_version != null) memory.supersedes = { eventId: row.supersedes_event_id, version: row.supersedes_version };
  if (row.confidence != null && row.confidence_basis != null) memory.confidence = { score: Number(row.confidence), basis: row.confidence_basis };
  if (row.fact != null) memory.fact = memoryFactSchema.parse(row.fact);
  return memory;
}
