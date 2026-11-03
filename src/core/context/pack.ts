import { OpenContinuityError } from "../../shared/errors.js";
import type { ContextCoverageRequirement, ContextPackResult, ParsedContextPackInput, ResolvedMemory } from "../../shared/types.js";
import type { RecallReader } from "../retrieval/contracts.js";
import { contextCoverage, uniqueContextMemories, validateCoverageRequirements } from "./coverage.js";
import { createPackingState } from "./packing/budget.js";
import { packByCoverage } from "./packing/coverage.js";
import { packByRank } from "./packing/rank.js";
import { resolveContextPackPolicy, selectContextCandidates, type ContextPackPolicy, type ResolvedContextPackPolicy } from "./selection.js";
export { estimateContextTokens } from "./rendering.js";
export type { ContextPackPolicy } from "./selection.js";


export class ContextPackBuilder {
  private readonly policy: Readonly<ResolvedContextPackPolicy>;
  constructor(private readonly retrieval: RecallReader, policy: ContextPackPolicy) {
    this.policy = resolveContextPackPolicy(policy);
  }

  capabilityPolicy() { return { ...this.policy }; }

  async build(input: ParsedContextPackInput): Promise<ContextPackResult> {
    const recall = await this.retrieval.recall({
      userId: input.userId, agentId: input.agentId, query: input.query, key: input.key, kind: input.kind, scope: input.scope, taskId: input.taskId,
      includePrivate: input.includePrivate, limit: 100, cursor: undefined,
    }, { requireUserConfirmed: this.policy.requireUserConfirmed });
    return this.buildFromMemories(input, recall.memories, recall.retrieval);
  }

  buildFromMemories(input: ParsedContextPackInput, memories: ResolvedMemory[], retrieval?: ContextPackResult["retrieval"], requirements?: ContextCoverageRequirement[]): ContextPackResult {
    const requestedTokens = input.tokenBudget ?? this.policy.defaultTokenBudget;
    if (requestedTokens > this.policy.maxTokenBudget) {
      throw new OpenContinuityError("VALIDATION_ERROR", "tokenBudget exceeds the active profile limit", 400, { requestedTokens, maxTokenBudget: this.policy.maxTokenBudget });
    }
    const maxMemories = Math.min(input.maxMemories ?? this.policy.maxMemories, this.policy.maxMemories);
    const unique = uniqueContextMemories(memories);
    const obligations = requirements ?? [{ id: "context-query", query: input.query, memoryIds: unique.memories.map(memory => memory.id) }];
    validateCoverageRequirements(obligations, unique.memories);
    const { ranked, receipt } = selectContextCandidates(input, unique.memories, this.policy);
    const state = createPackingState(requestedTokens, maxMemories);
    const packing = requirements ? this.policy.queryPacking : "rank_only";
    if (packing === "query_coverage") packByCoverage(ranked, obligations, state);
    packByRank(ranked, state);
    const { lines, items, omitted, accepted, usedTokens } = state;

    return structuredClone({
      context: lines.join("\n"), items, omitted,
      budget: { requestedTokens, usedTokens, remainingTokens: requestedTokens - usedTokens, maxMemories, estimation: "utf8_bytes_v1" },
      retrieval,
      selection: receipt,
      coverage: contextCoverage(obligations, accepted, omitted, packing, unique.duplicatesRemoved,
        new Set(unique.memories.filter(memory => this.policy.requireUserConfirmed && !memory.userConfirmed).map(memory => memory.id)), unique.memories.some(memory => memory.retrieval?.channels.includes("dense"))),
    });
  }

}
