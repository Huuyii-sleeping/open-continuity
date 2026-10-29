import type { SelectedContextCandidate } from "../contracts.js";
export function orderByInput(ranked: SelectedContextCandidate[]): void { ranked.sort((a, b) => a.selection.inputRank - b.selection.inputRank); }
