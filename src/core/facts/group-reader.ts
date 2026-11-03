import { OpenContinuityError } from "../../shared/errors.js";
import { type FactAssessment, type ResolvedMemory } from "../../shared/types.js";
import { assessFactGroup } from "./adjudication.js";
import type { FactGroupInput } from "./contracts.js";
import { matchesFactGroup, type FactGroupStore } from "./contracts.js";
type GroupAssessment = { decisions: Map<string, Decision>; coverage: FactAssessment["coverage"]; memories: ResolvedMemory[] };
type Decision = Pick<FactAssessment, "status" | "usable" | "reason">;
function inconsistent(): never { throw new OpenContinuityError("STORAGE_ERROR", "Inconsistent fact group evidence", 500); }
export async function loadFactGroup(store: Partial<FactGroupStore>, request: FactGroupInput, evaluatedAt: string): Promise<GroupAssessment> {
  let group: GroupAssessment;
  if (!store.readFactGroup) group = { decisions: new Map(), coverage: "unsupported", memories: [] };
  else {
    const result = await store.readFactGroup(request);
    if (typeof result.truncated !== "boolean" || result.memories.length > request.limit) inconsistent();
    for (const memory of result.memories) if (!matchesFactGroup(memory, request)) inconsistent();
    group = {
      decisions: result.truncated ? new Map() : assessFactGroup(result.memories, evaluatedAt),
      coverage: result.truncated ? "truncated" : "visible_filtered_group", memories: result.memories
    };
  }
  return group;
}
