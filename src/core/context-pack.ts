import { OpenContinuityError } from "../shared/errors.js";
import type { ContextPackItem, ContextPackOmission, ContextPackResult, ContextPurpose, ParsedContextPackInput, ResolvedMemory, ContextSelectionReason } from "../shared/types.js";
import type { RetrievalPipeline } from "./retrieval.js";

export interface ContextPackPolicy {
  defaultTokenBudget: number;
  maxTokenBudget: number;
  maxMemories: number;
}

interface RankedContextMemory { memory: ResolvedMemory; priority: number; reasons: ContextSelectionReason[]; }

const PURPOSE_KIND_WEIGHT: Record<ContextPurpose, Partial<Record<ResolvedMemory["kind"], number>>> = {
  general: { user_preference: 8, user_fact: 6, task_state: 7, decision: 7 },
  coding: { task_state: 12, decision: 10, user_preference: 8, user_fact: 5 },
  research: { decision: 12, user_fact: 10, task_state: 7, user_preference: 5 },
  browser: { user_preference: 12, task_state: 10, user_fact: 6, decision: 5 },
};

export function estimateContextTokens(text: string): number {
  return text.length === 0 ? 0 : Math.max(1, Math.ceil(Buffer.byteLength(text, "utf8") / 4));
}

function renderMemory(memory: ResolvedMemory): string {
  return JSON.stringify({ key: memory.key, value: memory.value, kind: memory.kind, scope: memory.scope, version: memory.version, ...(memory.taskId ? { taskId: memory.taskId } : {}), ...(memory.confidence ? { confidence: memory.confidence } : {}) });
}

function compareContextMemory(left: RankedContextMemory, right: RankedContextMemory): number {
  return right.priority - left.priority || right.memory.updatedAt.localeCompare(left.memory.updatedAt) || right.memory.id.localeCompare(left.memory.id);
}

export class ContextPackBuilder {
  constructor(private readonly retrieval: RetrievalPipeline, private readonly policy: ContextPackPolicy) {}

  async build(input: ParsedContextPackInput): Promise<ContextPackResult> {
    const recall = await this.retrieval.recall({
      userId: input.userId, agentId: input.agentId, query: input.query, key: input.key, kind: input.kind, scope: input.scope, taskId: input.taskId,
      includePrivate: input.includePrivate, limit: 100, cursor: undefined,
    });
    return this.buildFromMemories(input, recall.memories, recall.retrieval);
  }

  buildFromMemories(input: ParsedContextPackInput, memories: ResolvedMemory[], retrieval?: ContextPackResult["retrieval"]): ContextPackResult {
    const requestedTokens = input.tokenBudget ?? this.policy.defaultTokenBudget;
    if (requestedTokens > this.policy.maxTokenBudget) {
      throw new OpenContinuityError("VALIDATION_ERROR", "tokenBudget exceeds the active profile limit", 400, { requestedTokens, maxTokenBudget: this.policy.maxTokenBudget });
    }
    const maxMemories = Math.min(input.maxMemories ?? this.policy.maxMemories, this.policy.maxMemories);
    const ranked = memories.map((memory) => this.rank(memory, input)).sort(compareContextMemory);
    const items: ContextPackItem[] = [];
    const omitted: ContextPackOmission[] = [];
    const lines: string[] = [];
    let usedTokens = 0;

    for (const candidate of ranked) {
      const line = renderMemory(candidate.memory);
      const estimatedTokens = estimateContextTokens(line);
      if (items.length >= maxMemories) {
        omitted.push({ memoryId: candidate.memory.id, key: candidate.memory.key, estimatedTokens, reason: "max_memories" });
        continue;
      }
      const nextContext = lines.length === 0 ? line : lines.join("\n") + "\n" + line;
      const nextUsedTokens = estimateContextTokens(nextContext);
      if (nextUsedTokens > requestedTokens) {
        omitted.push({ memoryId: candidate.memory.id, key: candidate.memory.key, estimatedTokens, reason: "token_budget" });
        continue;
      }
      lines.push(line);
      usedTokens = nextUsedTokens;
      items.push({
        memoryId: candidate.memory.id, key: candidate.memory.key, value: candidate.memory.value, kind: candidate.memory.kind, scope: candidate.memory.scope,
        taskId: candidate.memory.taskId, estimatedTokens, priority: candidate.priority, reasons: candidate.reasons,
        sourceEventId: candidate.memory.sourceEventId, sourceAgentId: candidate.memory.sourceAgentId, updatedAt: candidate.memory.updatedAt,
        version: candidate.memory.version, supersedes: candidate.memory.supersedes, confidence: candidate.memory.confidence,
      });
    }

    return {
      context: lines.join("\n"), items, omitted,
      budget: { requestedTokens, usedTokens, remainingTokens: requestedTokens - usedTokens, maxMemories, estimation: "utf8_bytes_v1" },
      retrieval,
    };
  }

  private rank(memory: ResolvedMemory, input: ParsedContextPackInput): RankedContextMemory {
    const reasons: ContextSelectionReason[] = [];
    let priority = (memory.retrieval?.score ?? 0) * 1000;
    for (const channel of memory.retrieval?.channels ?? []) {
      reasons.push(channel === "exact" ? "retrieval_exact" : channel === "structured" ? "retrieval_structured" : "retrieval_full_text");
    }
    if (memory.scope === "task" && memory.taskId === input.taskId) { priority += 20; reasons.push("task_scope"); }
    if (memory.scope === "agent" && memory.ownerAgentId === input.agentId) { priority += 15; reasons.push("agent_scope"); }
    if (memory.userConfirmed) { priority += 10; reasons.push("user_confirmed"); }
    priority += PURPOSE_KIND_WEIGHT[input.purpose][memory.kind] ?? 0;
    reasons.push(`purpose_${input.purpose}`);
    return { memory, priority: Number(priority.toFixed(6)), reasons };
  }
}
