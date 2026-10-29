import type { CandidateSearchInput } from "../../../core/retrieval/contracts.js";
import type { InMemoryCandidateContext } from "./context.js";

export function eligibleInMemoryCandidates(context: InMemoryCandidateContext, input: CandidateSearchInput) {
  return Array.from(context.current()).filter(memory => {
    if (!context.belongsToUser(memory, input.userId) || !context.isVisible(memory, input.agentId, input.taskId)) return false;
    if ((!input.includePrivate && memory.sensitivity === "private") || (input.requireUserConfirmed && !memory.userConfirmed)) return false;
    return !((input.scope && memory.scope !== input.scope) || (input.kind && memory.kind !== input.kind) || (input.key && memory.key !== input.key));
  });
}
