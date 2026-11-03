import { isDeepStrictEqual } from "node:util";
import { OpenContinuityError } from "../../shared/errors.js";
import { memoryFactSchema, type ResolvedMemory } from "../../shared/types.js";
import type { FactDecision as Decision } from "./contracts.js";
import { resolveFactReferences } from "./references.js";
import { temporal } from "./validity.js";
function inconsistent(): never { throw new OpenContinuityError("STORAGE_ERROR", "Inconsistent fact group evidence", 500); }
export function assessFactGroup(memories: ResolvedMemory[], evaluatedAt: string): Map<string, Decision> {
  const at = Date.parse(evaluatedAt);
  if (!Number.isFinite(at)) throw new OpenContinuityError("VALIDATION_ERROR", "Invalid fact evaluation time", 400);
  const decisions = new Map<string, Decision>();
  const byId = new Map(memories.map(memory => [memory.id, memory]));
  if (byId.size !== memories.length) inconsistent();
  const partition = (memory: ResolvedMemory) => JSON.stringify([memory.fact?.group, memory.scope, memory.taskId, memory.ownerAgentId, memory.kind]);
  for (const memory of memories) {
    if (!memory.fact || !memory.userConfirmed || !memoryFactSchema.safeParse(memory.fact).success) inconsistent();
    if (partition(memory) !== partition(memories[0]!)) inconsistent();
    const time = temporal(memory, at);
    if (time) decisions.set(memory.id, time);
  }
  const active = memories.filter(memory => !decisions.has(memory.id));
  const { unresolved, cyclic, replaced } = resolveFactReferences(active, byId);
  if (unresolved || cyclic) {
    for (const memory of active) decisions.set(memory.id, { status: "unresolved", usable: false, reason: cyclic ? "replacement_cycle" : "unverified_reference" });
    return decisions;
  }
  for (const memory of active) if (replaced.has(memory.id)) decisions.set(memory.id, { status: "superseded", usable: false, reason: "verified_replacement" });
  const survivors = active.filter(memory => !replaced.has(memory.id));
  const conflict = survivors.some(memory => !isDeepStrictEqual(memory.value, survivors[0]?.value));
  for (const memory of survivors) decisions.set(memory.id, conflict
    ? { status: "conflict", usable: false, reason: "different_visible_values" }
    : survivors.length > 1 ? { status: "consistent_assertions", usable: true, reason: "equal_visible_values" }
      : { status: "active_assertion", usable: true, reason: "single_visible_assertion" });
  return decisions;
}
