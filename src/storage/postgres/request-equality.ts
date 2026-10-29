import { isDeepStrictEqual } from "node:util";
import type { QueryResultRow } from "pg";
import { sameEvolutionRequest } from "../../core/memory/evolution.js";
import type { ParsedRememberInput } from "../../shared/types.js";
import { memoryFactSchema } from "../../shared/types.js";
export function sameRequest(row: QueryResultRow, input: ParsedRememberInput): boolean {
  return row.event_type === "memory_remembered" && row.user_id === input.userId && row.agent_id === input.agentId && row.memory_key === input.key && row.kind === input.kind
    && row.scope === input.scope && (row.task_id ?? undefined) === input.taskId && row.sensitivity === input.sensitivity
    && row.user_confirmed === input.userConfirmed && sameEvolutionRequest({
      inputValue: row.input_value ?? undefined, value: row.value, writeMode: row.write_mode ?? undefined,
      expectedVersion: row.expected_version ?? undefined,
      confidence: row.confidence == null || row.confidence_basis == null ? undefined : { score: Number(row.confidence), basis: row.confidence_basis },
      fact: row.fact == null ? undefined : memoryFactSchema.parse(row.fact),
    }, input)
    && isDeepStrictEqual(row.metadata ?? {}, input.metadata);
}
