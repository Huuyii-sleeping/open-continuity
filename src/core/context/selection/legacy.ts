import type { SelectedContextCandidate } from "../contracts.js";
export function orderByLegacyWeight(ranked: SelectedContextCandidate[]): void { ranked.sort((a, b) => b.priority - a.priority || b.memory.updatedAt.localeCompare(a.memory.updatedAt) || b.memory.id.localeCompare(a.memory.id)); }
