import { isDeepStrictEqual } from "node:util";
import { sameEvolutionRequest } from "../../core/memory/evolution.js";
import { type MemoryEvent, type ParsedRememberInput } from "../../shared/types.js";
export function sameRememberRequest(event: MemoryEvent, input: ParsedRememberInput): boolean {
  return event.type === "memory_remembered" && event.userId === input.userId && event.agentId === input.agentId && event.key === input.key && event.kind === input.kind
    && event.scope === (input.scope || "user") && event.taskId === input.taskId && event.sensitivity === (input.sensitivity || "public")
    && event.userConfirmed === (input.userConfirmed || false) && sameEvolutionRequest(event, input)
    && isDeepStrictEqual(event.metadata, input.metadata)
}
