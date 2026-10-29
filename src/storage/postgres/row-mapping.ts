import type { QueryResultRow } from "pg";
import type { ResolvedMemory } from "../../shared/types.js";
import { memoryFactSchema } from "../../shared/types.js";

function iso(value: unknown): string {
  return value instanceof Date ? value.toISOString() : new Date(String(value)).toISOString();
}

export function rowToMemory(row: QueryResultRow): ResolvedMemory {
  const memory: ResolvedMemory = {
    id: row.id, key: row.memory_key, value: structuredClone(row.value), kind: row.kind, scope: row.scope,
    taskId: row.task_id ?? undefined, ownerAgentId: row.owner_agent_id ?? undefined, sensitivity: row.sensitivity,
    userConfirmed: row.user_confirmed, sourceEventId: row.source_event_id, sourceAgentId: row.source_agent_id,
    updatedAt: iso(row.updated_at), version: row.version,
  };
  if (row.supersedes_event_id != null && row.supersedes_version != null) memory.supersedes = { eventId: row.supersedes_event_id, version: row.supersedes_version };
  if (row.confidence != null && row.confidence_basis != null) memory.confidence = { score: Number(row.confidence), basis: row.confidence_basis };
  if (row.fact != null) memory.fact = memoryFactSchema.parse(row.fact);
  return memory;
}
