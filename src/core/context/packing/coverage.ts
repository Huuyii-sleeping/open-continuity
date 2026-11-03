import type { ContextCoverageRequirement } from "../../../shared/types.js";
import type { SelectedContextCandidate } from "../contracts.js";
import type { PackingState } from "./contracts.js";
export function packByCoverage(ranked: SelectedContextCandidate[], obligations: ContextCoverageRequirement[], state: PackingState): void {
  const { accepted, rejected, append } = state;
  // Greedy maximum uncovered-query gain; stable rank breaks ties. Query has <=32 obligations and <=800 candidates.
  {
    const uncovered = new Set(obligations.map(requirement => requirement.id));
    while (uncovered.size && state.hasCapacity()) {
      const gain = (id: string) => obligations.filter(requirement => uncovered.has(requirement.id) && requirement.memoryIds.includes(id)).length;
      const remaining = ranked.filter(candidate => !accepted.has(candidate.memory.id) && !rejected.has(candidate.memory.id) && gain(candidate.memory.id) > 0);
      remaining.sort((a, b) => gain(b.memory.id) - gain(a.memory.id));
      const candidate = remaining[0];
      if (!candidate) break;
      if (append(candidate)) for (const requirement of obligations) if (requirement.memoryIds.includes(candidate.memory.id)) uncovered.delete(requirement.id);
    }
  }
}
