import { OpenContinuityError } from "../../../shared/errors.js";
import type { ParsedContextPackInput, ResolvedMemory } from "../../../shared/types.js";
import { type ResolvedContextPackPolicy } from "../contracts.js";

function invalid(): never { throw new OpenContinuityError("STORAGE_ERROR", "Invalid context candidate evidence", 500); }
export function eligibleContextMemories(input: ParsedContextPackInput, memories: ResolvedMemory[], policy: Readonly<ResolvedContextPackPolicy>) {
  const eligible = memories.map((memory, index) => ({ memory, inputRank: index + 1 }))
    .filter(({ memory }) => !policy.requireUserConfirmed || memory.userConfirmed);
  for (const { memory } of eligible) {
    if ((!input.includePrivate && memory.sensitivity === "private")
      || (memory.scope === "agent" && memory.ownerAgentId !== input.agentId)
      || (memory.scope === "task" && (!input.taskId || memory.taskId !== input.taskId))
      || (input.key && memory.key !== input.key) || (input.kind && memory.kind !== input.kind)
      || (input.scope && memory.scope !== input.scope)) invalid();
    const evidence = memory.retrieval;
    if (evidence && (!Number.isFinite(evidence.score) || evidence.score < 0
      || (evidence.exactTier !== undefined && ![0, 1].includes(evidence.exactTier)))) invalid();
  }
  return eligible;
}
