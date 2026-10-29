import type { SelectedContextCandidate } from "../contracts.js";
import type { PackingState } from "./contracts.js";
export function packByRank(ranked: SelectedContextCandidate[], state: PackingState): void {
  const { accepted, rejected, append } = state;
  for (const candidate of ranked) if (!accepted.has(candidate.memory.id) && !rejected.has(candidate.memory.id)) append(candidate);
}
