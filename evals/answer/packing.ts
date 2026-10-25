import type { ContextPackBuilder } from "../../src/core/context-pack.js";
import type { ContextCoverageRequirement, ResolvedMemory } from "../../src/shared/types.js";
import { actor } from "./dataset.js";
function memory(id: string, score: number, value = "fictional evidence"): ResolvedMemory {
  return { id, key: id, value, kind: "decision", scope: "user", userConfirmed: true, sensitivity: "public", version: 1,
    sourceAgentId: actor.agentId, sourceEventId: `fictional-${id}`, updatedAt: "2031-01-01T00:00:00Z",
    retrieval: { score, channels: ["full_text"], ranks: { full_text: 1 }, exactTier: 0 } };
}
export function packingAblation(create: (mode: "query_coverage" | "rank_only") => ContextPackBuilder) {
  const standard = [memory("alpha-one", 0.04), memory("alpha-two", 0.03), memory("beta", 0.02)];
  const needs: ContextCoverageRequirement[] = [{ id: "a", query: "alpha", memoryIds: ["alpha-one", "alpha-two"] }, { id: "b", query: "beta", memoryIds: ["beta"] }];
  const cases = [
    { id: "distinct-query-coverage", memories: standard, requirements: needs, expectedCovered: 2, maxMemories: 2, tokenBudget: 4096 },
    { id: "shared-evidence", memories: [...standard, memory("shared", 0.001)], requirements: needs.map(item => ({ ...item, memoryIds: [...item.memoryIds, "shared"] })), expectedCovered: 2, maxMemories: 1, tokenBudget: 4096 },
    { id: "oversized-first", memories: [memory("huge", 0.1, "x".repeat(5000)), standard[2]], requirements: [{ id: "b", query: "beta", memoryIds: ["huge", "beta"] }], expectedCovered: 1, maxMemories: 1, tokenBudget: 256 },
  ];
  return ["query_coverage", "rank_only"].flatMap(mode => cases.map(scenario => {
    const result = create(mode as "query_coverage" | "rank_only").buildFromMemories({ ...actor, query: "alpha and beta", purpose: "general", includePrivate: false,
      maxMemories: scenario.maxMemories, tokenBudget: scenario.tokenBudget }, scenario.memories, undefined, scenario.requirements);
    return { mode, id: scenario.id, expectedCovered: scenario.expectedCovered, actualCovered: result.coverage?.coveredQueries ?? null,
      selected: result.items.map(item => item.memoryId), usedTokens: result.budget.usedTokens, passed: result.coverage?.coveredQueries === scenario.expectedCovered };
  }));
}
