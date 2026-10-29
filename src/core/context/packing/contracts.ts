import type { ContextPackItem, ContextPackOmission } from "../../../shared/types.js";
import type { SelectedContextCandidate } from "../contracts.js";
export interface PackingState { readonly items: ContextPackItem[]; readonly omitted: ContextPackOmission[]; readonly lines: string[]; readonly accepted: Set<string>; readonly rejected: Set<string>; readonly usedTokens: number; append(candidate: SelectedContextCandidate): boolean; hasCapacity(): boolean; }
