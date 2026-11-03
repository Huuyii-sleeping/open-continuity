import type { MemoryEvent, ResolvedMemory } from "../../shared/types.js";
import { memoryFactSchema } from "../../shared/types.js";
import { type SqliteRow } from "./row-mapping.js";
export function parseJson(value: unknown): unknown {
  return JSON.parse(String(value));
}
export function rowToEvent(row: SqliteRow): MemoryEvent {
  const event: MemoryEvent = {
    id: String(row.id), userId: String(row.user_id), agentId: String(row.agent_id),
    type: row.event_type as MemoryEvent["type"], memoryId: String(row.memory_id), key: String(row.memory_key),
    kind: row.kind as MemoryEvent["kind"], scope: row.scope as MemoryEvent["scope"],
    taskId: row.task_id == null ? undefined : String(row.task_id), sensitivity: row.sensitivity as MemoryEvent["sensitivity"],
    userConfirmed: Number(row.user_confirmed) === 1, idempotencyKey: String(row.idempotency_key),
    createdAt: String(row.created_at), metadata: parseJson(row.metadata) as Record<string, unknown>,
    memoryVersion: Number(row.memory_version),
  };
  if (event.type === "memory_remembered") event.value = parseJson(row.value);
  if (event.type === "memory_remembered") {
    if (row.input_value != null) event.inputValue = parseJson(row.input_value);
    if (row.evolution_action != null) event.evolutionAction = row.evolution_action as NonNullable<MemoryEvent["evolutionAction"]>;
    if (row.write_mode != null) event.writeMode = row.write_mode as NonNullable<MemoryEvent["writeMode"]>;
    if (row.expected_version != null) event.expectedVersion = Number(row.expected_version);
    if (row.supersedes_event_id != null && row.supersedes_version != null) event.supersedes = { eventId: String(row.supersedes_event_id), version: Number(row.supersedes_version) };
    if (row.confidence != null && row.confidence_basis != null) event.confidence = { score: Number(row.confidence), basis: row.confidence_basis as NonNullable<MemoryEvent["confidence"]>["basis"] };
  }
  if (row.fact != null) event.fact = memoryFactSchema.parse(parseJson(row.fact));
  return event;
}
export function eventSnapshot(row: SqliteRow): ResolvedMemory {
  const memory: ResolvedMemory = {
    id: String(row.memory_id), key: String(row.memory_key), value: parseJson(row.value),
    kind: row.kind as ResolvedMemory["kind"], scope: row.scope as ResolvedMemory["scope"],
    taskId: row.task_id == null ? undefined : String(row.task_id),
    ownerAgentId: row.scope === "agent" ? String(row.agent_id) : undefined,
    sensitivity: row.sensitivity as ResolvedMemory["sensitivity"], userConfirmed: Number(row.user_confirmed) === 1,
    sourceEventId: String(row.id), sourceAgentId: String(row.agent_id), updatedAt: String(row.created_at),
    version: Number(row.memory_version),
  };
  if (row.supersedes_event_id != null && row.supersedes_version != null) memory.supersedes = { eventId: String(row.supersedes_event_id), version: Number(row.supersedes_version) };
  if (row.confidence != null && row.confidence_basis != null) memory.confidence = { score: Number(row.confidence), basis: row.confidence_basis as NonNullable<ResolvedMemory["confidence"]>["basis"] };
  if (row.fact != null) memory.fact = memoryFactSchema.parse(parseJson(row.fact));
  return memory;
}
