import type { ResolvedMemory } from "../../shared/types.js";
import { memoryFactSchema } from "../../shared/types.js";
export type SqliteRow = Record<string, unknown>;
function parseJson(value: unknown): unknown { return JSON.parse(String(value)); }

export function rowToMemory(row: SqliteRow): ResolvedMemory {
  const memory: ResolvedMemory = {
    id: String(row.id), key: String(row.memory_key), value: parseJson(row.value), kind: row.kind as ResolvedMemory["kind"],
    scope: row.scope as ResolvedMemory["scope"], taskId: row.task_id == null ? undefined : String(row.task_id),
    ownerAgentId: row.owner_agent_id == null ? undefined : String(row.owner_agent_id),
    sensitivity: row.sensitivity as ResolvedMemory["sensitivity"], userConfirmed: Number(row.user_confirmed) === 1,
    sourceEventId: String(row.source_event_id), sourceAgentId: String(row.source_agent_id),
    updatedAt: String(row.updated_at), version: Number(row.version),
  };
  if (row.supersedes_event_id != null && row.supersedes_version != null) memory.supersedes = { eventId: String(row.supersedes_event_id), version: Number(row.supersedes_version) };
  if (row.confidence != null && row.confidence_basis != null) memory.confidence = { score: Number(row.confidence), basis: row.confidence_basis as NonNullable<ResolvedMemory["confidence"]>["basis"] };
  if (row.fact != null) memory.fact = memoryFactSchema.parse(parseJson(row.fact));
  return memory;
}
