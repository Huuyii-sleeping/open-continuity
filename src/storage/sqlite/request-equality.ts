import { isDeepStrictEqual } from "node:util";
import { sameEvolutionRequest } from "../../core/memory/evolution.js";
import type { ParsedRememberInput, ResolvedMemory } from "../../shared/types.js";
import { memoryFactSchema } from "../../shared/types.js";
import { parseJson } from "./event-mapping.js";
import { type SqliteRow } from "./row-mapping.js";
export function sameRequest(row: SqliteRow, input: ParsedRememberInput): boolean {
  return row.event_type === "memory_remembered" && row.user_id === input.userId && row.agent_id === input.agentId && row.memory_key === input.key && row.kind === input.kind
    && row.scope === input.scope && (row.task_id ?? undefined) === input.taskId && row.sensitivity === input.sensitivity
    && Number(row.user_confirmed) === Number(input.userConfirmed) && sameEvolutionRequest({
      inputValue: row.input_value == null ? undefined : parseJson(row.input_value), value: parseJson(row.value),
      writeMode: row.write_mode == null ? undefined : String(row.write_mode),
      expectedVersion: row.expected_version == null ? undefined : Number(row.expected_version),
      confidence: row.confidence == null || row.confidence_basis == null ? undefined : { score: Number(row.confidence), basis: row.confidence_basis as NonNullable<ResolvedMemory["confidence"]>["basis"] },
      fact: row.fact == null ? undefined : memoryFactSchema.parse(parseJson(row.fact)),
    }, input)
    && isDeepStrictEqual(parseJson(row.metadata), input.metadata);
}
