import { isDeepStrictEqual } from "node:util";
import { OpenContinuityError } from "../../shared/errors.js";
import { type FactAssessment, type ParsedRecallInput, type ResolvedMemory } from "../../shared/types.js";
import type { RankedEvidence } from "../retrieval/contracts.js";
import { parseFactGroupRequest, type FactGroupStore, type FactResolutionResult } from "./contracts.js";
import { loadFactGroup } from "./group-reader.js";
export { assessFactGroup } from "./adjudication.js";

export const FACT_POLICY = "explicit-facts-v1" as const;
type Decision = Pick<FactAssessment, "status" | "usable" | "reason">;

function current(memory: ResolvedMemory) { const { retrieval: _retrieval, ...snapshot } = memory; return snapshot; }
function inconsistent(): never { throw new OpenContinuityError("STORAGE_ERROR", "Inconsistent fact group evidence", 500); }


export async function resolveFacts(ranked: RankedEvidence[], store: Partial<FactGroupStore>, input: ParsedRecallInput,
  policy: { requireUserConfirmed: boolean; groupLimit: number }, evaluatedAt = new Date().toISOString()): Promise<FactResolutionResult> {
  const cache = new Map<string, { decisions: Map<string, Decision>; coverage: FactAssessment["coverage"]; memories: ResolvedMemory[] }>();
  const accepted: RankedEvidence[] = [], omitted: Array<{ memoryId: string; assessment: FactAssessment }> = [];
  for (const item of ranked) {
    let decision: Decision = { status: "unannotated", usable: true, reason: "legacy_unverified" };
    let coverage: FactAssessment["coverage"] = "not_applicable";
    if (item.memory.fact) {
      const request = parseFactGroupRequest({
        userId: input.userId, agentId: input.agentId,
        group: item.memory.fact.group, scope: item.memory.scope, taskId: input.taskId, kind: item.memory.kind,
        includePrivate: input.includePrivate, requireUserConfirmed: policy.requireUserConfirmed, limit: policy.groupLimit
      });
      const identity = JSON.stringify([request.group, request.scope, request.kind, item.memory.taskId, item.memory.ownerAgentId]);
      let group = cache.get(identity);
      if (!group) {
        group = await loadFactGroup(store, request, evaluatedAt);
        cache.set(identity, group);
      }
      coverage = group.coverage;
      if (coverage === "visible_filtered_group") {
        const snapshot = group.memories.find(memory => memory.id === item.memory.id);
        if (!snapshot || !isDeepStrictEqual(current(snapshot), current(item.memory))) inconsistent();
        decision = group.decisions.get(item.memory.id) ?? inconsistent();
      } else decision = { status: "unresolved", usable: false, reason: coverage === "truncated" ? "group_budget" : "store_unsupported" };
    }
    const assessment: FactAssessment = { policy: FACT_POLICY, evaluatedAt, ...decision, coverage };
    if (assessment.usable) accepted.push({ ...item, retrieval: { ...item.retrieval, factAssessment: assessment } });
    else omitted.push({ memoryId: item.memory.id, assessment });
  }
  return { ranked: accepted, review: { policy: FACT_POLICY, evaluatedAt, groupLimit: policy.groupLimit, reviewedGroups: cache.size, omitted } };
}
