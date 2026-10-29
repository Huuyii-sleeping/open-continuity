import { contextPackInputSchema, agenticQueryInputSchema, type AgenticEvidence, type ResolvedMemory } from "../../src/shared/types.js";
import type { SelectedContextCandidate } from "../../src/core/context/contracts.js";
import { ContextPackBuilder } from "../../src/core/context/pack.js";

export const routeActor = { userId: "fictional-route-user", agentId: "fictional-route-agent" };
export const routeContextPolicy = { defaultTokenBudget: 4096, maxTokenBudget: 4096, maxMemories: 10, requireUserConfirmed: true };
export const routeQueryPolicy = { defaultMaxSteps: 3, maxSteps: 4, defaultTimeoutMs: 1500, maxTimeoutMs: 5000, maxSubqueries: 3, historyLimit: 5 };
export const routeInput = () => agenticQueryInputSchema.parse({ ...routeActor, query: "needle" });
export function routeMemory(extra: Partial<ResolvedMemory> = {}): ResolvedMemory {
  return { id: "00000000-0000-4000-8000-000000000001", sourceEventId: "10000000-0000-4000-8000-000000000001", key: "fictional-needle", value: "fictional needle", kind: "decision", scope: "user", sensitivity: "public", userConfirmed: true, sourceAgentId: routeActor.agentId, version: 1, updatedAt: "2031-01-01T00:00:00.000Z", ...extra };
}
export function routeCandidate(extra: Partial<ResolvedMemory> = {}): SelectedContextCandidate {
  return { memory: routeMemory(extra), priority: 1, reasons: [], selection: { inputRank: 1, exactTier: 0, retrievalScore: 1, scoreModel: "rank_reciprocal", purposePreference: 0 } };
}
export function routeEvidence(memory = routeMemory()): AgenticEvidence {
  return { memory, matchedQueries: ["needle"], stepIds: ["recall-1"], score: 1 };
}
export function routePack(memory = routeMemory()) {
  return new ContextPackBuilder({ recall: async () => ({ memories: [], nextCursor: null }) }, routeContextPolicy).buildFromMemories(contextPackInputSchema.parse({ ...routeActor, query: "needle" }), [memory]);
}
export const routeSufficiency = () => ({ status: "sufficient" as const, evidenceCount: 1, matchedQueries: 1, totalQueries: 1, reasons: [] });
