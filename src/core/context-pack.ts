import { OpenContinuityError } from "../shared/errors.js";
import type { ContextCoverageRequirement, ContextPackItem, ContextPackOmission, ContextPackResult, ParsedContextPackInput, ResolvedMemory } from "../shared/types.js";
import type { RetrievalPipeline } from "./retrieval.js";
import { resolveContextPackPolicy, selectContextCandidates, type ContextPackPolicy, type ResolvedContextPackPolicy } from "./context-selection.js";
export type { ContextPackPolicy } from "./context-selection.js";
import { contextCoverage, uniqueContextMemories, validateCoverageRequirements } from "./context-coverage.js";

export function estimateContextTokens(text: string): number {
  return text.length === 0 ? 0 : Math.max(1, Math.ceil(Buffer.byteLength(text, "utf8") / 4));
}

function renderMemory(memory: ResolvedMemory): string {
  return JSON.stringify({ key: memory.key, value: memory.value, kind: memory.kind, scope: memory.scope, version: memory.version, ...(memory.taskId ? { taskId: memory.taskId } : {}), ...(memory.confidence ? { confidence: memory.confidence } : {}),
    ...(memory.fact ? { fact: { group: memory.fact.group, validFrom: memory.fact.validFrom, validUntil: memory.fact.validUntil, status: memory.retrieval?.factAssessment?.status ?? "unresolved" } } : {}) });
}

export class ContextPackBuilder {
  private readonly policy: Readonly<ResolvedContextPackPolicy>;
  constructor(private readonly retrieval: RetrievalPipeline, policy: ContextPackPolicy) {
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
    const items: ContextPackItem[] = [];
    const omitted: ContextPackOmission[] = [];
    const lines: string[] = [];
    let usedTokens = 0;

    const accepted = new Set<string>();
    const rejected = new Set<string>();
    const append = (candidate: typeof ranked[number]) => {
      const line = renderMemory(candidate.memory);
      const estimatedTokens = estimateContextTokens(line);
      if (candidate.memory.fact && !candidate.memory.retrieval?.factAssessment?.usable) {
        omitted.push({ memoryId: candidate.memory.id, key: candidate.memory.key, estimatedTokens, reason: "fact_unresolved" });
        rejected.add(candidate.memory.id); return false;
      }
      if (items.length >= maxMemories) {
        omitted.push({ memoryId: candidate.memory.id, key: candidate.memory.key, estimatedTokens, reason: "max_memories" });
        rejected.add(candidate.memory.id); return false;
      }
      const nextContext = lines.length === 0 ? line : lines.join("\n") + "\n" + line;
      const nextUsedTokens = estimateContextTokens(nextContext);
      if (nextUsedTokens > requestedTokens) {
        omitted.push({ memoryId: candidate.memory.id, key: candidate.memory.key, estimatedTokens, reason: "token_budget" });
        rejected.add(candidate.memory.id); return false;
      }
      lines.push(line);
      usedTokens = nextUsedTokens;
      items.push({
        memoryId: candidate.memory.id, key: candidate.memory.key, value: candidate.memory.value, kind: candidate.memory.kind, scope: candidate.memory.scope,
        taskId: candidate.memory.taskId, estimatedTokens, priority: candidate.priority, reasons: candidate.reasons,
        sourceEventId: candidate.memory.sourceEventId, sourceAgentId: candidate.memory.sourceAgentId, updatedAt: candidate.memory.updatedAt,
        version: candidate.memory.version, supersedes: candidate.memory.supersedes, confidence: candidate.memory.confidence,
        retrieval: candidate.memory.retrieval,
        fact: candidate.memory.fact,
        selection: candidate.selection,
      });
      accepted.add(candidate.memory.id); return true;
    };
    const packing = requirements ? this.policy.queryPacking : "rank_only";
    // Greedy maximum uncovered-query gain; stable rank breaks ties. Query has <=32 obligations and <=800 candidates.
    if (packing === "query_coverage") {
      const uncovered = new Set(obligations.map(requirement => requirement.id));
      while (uncovered.size && items.length < maxMemories) {
        const gain = (id: string) => obligations.filter(requirement => uncovered.has(requirement.id) && requirement.memoryIds.includes(id)).length;
        const remaining = ranked.filter(candidate => !accepted.has(candidate.memory.id) && !rejected.has(candidate.memory.id) && gain(candidate.memory.id) > 0);
        remaining.sort((a, b) => gain(b.memory.id) - gain(a.memory.id));
        const candidate = remaining[0];
        if (!candidate) break;
        if (append(candidate)) for (const requirement of obligations) if (requirement.memoryIds.includes(candidate.memory.id)) uncovered.delete(requirement.id);
      }
    }
    for (const candidate of ranked) if (!accepted.has(candidate.memory.id) && !rejected.has(candidate.memory.id)) append(candidate);

    return structuredClone({
      context: lines.join("\n"), items, omitted,
      budget: { requestedTokens, usedTokens, remainingTokens: requestedTokens - usedTokens, maxMemories, estimation: "utf8_bytes_v1" },
      retrieval,
      selection: receipt,
      coverage: contextCoverage(obligations, accepted, omitted, packing, unique.duplicatesRemoved,
        new Set(unique.memories.filter(memory => this.policy.requireUserConfirmed && !memory.userConfirmed).map(memory => memory.id))),
    });
  }

}
