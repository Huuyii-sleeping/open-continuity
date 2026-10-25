import { isDeepStrictEqual } from "node:util";
import { OpenContinuityError } from "../shared/errors.js";
import { memoryFactSchema, type FactAssessment, type ParsedRecallInput, type ResolvedMemory } from "../shared/types.js";
import type { RankedEvidence } from "./evidence-ranking.js";
import { matchesFactGroup, parseFactGroupRequest, type FactGroupStore } from "./fact-store.js";

export const FACT_POLICY = "explicit-facts-v1" as const;
type Decision = Pick<FactAssessment, "status" | "usable" | "reason">;
function temporal(memory: ResolvedMemory, at: number): Decision | undefined {
  if (memory.fact?.validFrom && at < Date.parse(memory.fact.validFrom)) return { status: "not_yet_valid", usable: false, reason: "validity_start" };
  if (memory.fact?.validUntil && at >= Date.parse(memory.fact.validUntil)) return { status: "expired", usable: false, reason: "validity_end" };
  return undefined;
}
function current(memory: ResolvedMemory) { const { retrieval: _retrieval, ...snapshot } = memory; return snapshot; }
function inconsistent(): never { throw new OpenContinuityError("STORAGE_ERROR", "Inconsistent fact group evidence", 500); }

/** Conservative literal adjudication. Claims are not truth; hidden evidence is never consulted. */
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
  const edges = new Map<string, string[]>();
  let unresolved = false;
  for (const memory of active) {
    const targets: string[] = [];
    for (const ref of memory.fact!.supersedes) {
      const target = byId.get(ref.memoryId);
      if (!target || target.sourceEventId !== ref.sourceEventId || target.version !== ref.version) unresolved = true;
      else targets.push(target.id);
    }
    edges.set(memory.id, targets);
  }
  const visiting = new Set<string>(), visited = new Set<string>();
  function cycle(id: string): boolean {
    if (visiting.has(id)) return true;
    if (visited.has(id)) return false;
    visiting.add(id);
    for (const target of edges.get(id) ?? []) if (cycle(target)) return true;
    visiting.delete(id); visited.add(id); return false;
  }
  const cyclic = active.some(memory => cycle(memory.id));
  if (unresolved || cyclic) {
    for (const memory of active) decisions.set(memory.id, { status: "unresolved", usable: false, reason: cyclic ? "replacement_cycle" : "unverified_reference" });
    return decisions;
  }
  const replaced = new Set([...edges.values()].flat());
  for (const memory of active) if (replaced.has(memory.id)) decisions.set(memory.id, { status: "superseded", usable: false, reason: "verified_replacement" });
  const survivors = active.filter(memory => !replaced.has(memory.id));
  const conflict = survivors.some(memory => !isDeepStrictEqual(memory.value, survivors[0]?.value));
  for (const memory of survivors) decisions.set(memory.id, conflict
    ? { status: "conflict", usable: false, reason: "different_visible_values" }
    : survivors.length > 1 ? { status: "consistent_assertions", usable: true, reason: "equal_visible_values" }
    : { status: "active_assertion", usable: true, reason: "single_visible_assertion" });
  return decisions;
}

export async function resolveFacts(ranked: RankedEvidence[], store: Partial<FactGroupStore>, input: ParsedRecallInput,
  policy: { requireUserConfirmed: boolean; groupLimit: number }, evaluatedAt = new Date().toISOString()) {
  const cache = new Map<string, { decisions: Map<string, Decision>; coverage: FactAssessment["coverage"]; memories: ResolvedMemory[] }>();
  const accepted: RankedEvidence[] = [], omitted: Array<{ memoryId: string; assessment: FactAssessment }> = [];
  for (const item of ranked) {
    let decision: Decision = { status: "unannotated", usable: true, reason: "legacy_unverified" };
    let coverage: FactAssessment["coverage"] = "not_applicable";
    if (item.memory.fact) {
      const request = parseFactGroupRequest({ userId: input.userId, agentId: input.agentId,
        group: item.memory.fact.group, scope: item.memory.scope, taskId: input.taskId, kind: item.memory.kind,
        includePrivate: input.includePrivate, requireUserConfirmed: policy.requireUserConfirmed, limit: policy.groupLimit });
      const identity = JSON.stringify([request.group, request.scope, request.kind, item.memory.taskId, item.memory.ownerAgentId]);
      let group = cache.get(identity);
      if (!group) {
        if (!store.readFactGroup) group = { decisions: new Map(), coverage: "unsupported", memories: [] };
        else {
          const result = await store.readFactGroup(request);
          if (typeof result.truncated !== "boolean" || result.memories.length > request.limit) inconsistent();
          for (const memory of result.memories) if (!matchesFactGroup(memory, request)) inconsistent();
          group = { decisions: result.truncated ? new Map() : assessFactGroup(result.memories, evaluatedAt),
            coverage: result.truncated ? "truncated" : "visible_filtered_group", memories: result.memories };
        }
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
