import { type ResolvedMemory } from "../../shared/types.js";
import type { FactDecision } from "./contracts.js";
export function temporal(memory: ResolvedMemory, at: number): FactDecision | undefined {
  if (memory.fact?.validFrom && at < Date.parse(memory.fact.validFrom)) return { status: "not_yet_valid", usable: false, reason: "validity_start" };
  if (memory.fact?.validUntil && at >= Date.parse(memory.fact.validUntil)) return { status: "expired", usable: false, reason: "validity_end" };
  return undefined;
}
