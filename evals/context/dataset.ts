import type { ParsedContextPackInput, ResolvedMemory } from "../../src/shared/types.js";
export const actor = { userId: "fictional-context-eval-user", agentId: "fictional-context-eval-agent", taskId: "fictional-context-eval-task" };
export interface ContextCase {
  id: string; rationale: string; purpose: ParsedContextPackInput["purpose"]; candidates: ResolvedMemory[];
  expected: string[]; forbidden: string[];
}
function record(id: string, score: number, extra: Partial<ResolvedMemory> = {}): ResolvedMemory {
  return { id, key: `fictional-${id}`, value: "fictional evaluation evidence", kind: "user_fact", scope: "user", sensitivity: "public", userConfirmed: false,
    sourceEventId: `fictional-event-${id}`, sourceAgentId: actor.agentId, updatedAt: "2031-01-01T00:00:00.000Z", version: 1,
    retrieval: { score, channels: ["full_text"], ranks: { full_text: 1 }, scoreModel: "rank_reciprocal", exactTier: 0 }, ...extra };
}
export const CONTEXT_CASES: ContextCase[] = [
  { id: "task-weight", rationale: "A weaker query match must not displace the stronger one just because its scope is task.", purpose: "coding",
    candidates: [record("direct", 1 / 61), record("weak", 1 / 62, { kind: "task_state", scope: "task", taskId: actor.taskId })], expected: ["direct"], forbidden: ["weak"] },
  { id: "agent-weight", rationale: "Agent visibility is not evidence of question relevance.", purpose: "general",
    candidates: [record("direct", 1 / 61), record("weak", 1 / 62, { scope: "agent", ownerAgentId: actor.agentId })], expected: ["direct"], forbidden: ["weak"] },
  { id: "confirmation-weight", rationale: "Optional confirmation is not a relevance boost in ordinary Context.", purpose: "general",
    candidates: [record("direct", 1 / 61), record("weak", 1 / 62, { userConfirmed: true })], expected: ["direct"], forbidden: ["weak"] },
  { id: "purpose-weight", rationale: "A purpose preference cannot override unequal scores.", purpose: "research",
    candidates: [record("direct", 1 / 61, { kind: "user_preference" }), record("weak", 1 / 62, { kind: "decision" })], expected: ["direct"], forbidden: ["weak"] },
  { id: "exact-tier", rationale: "An explicit exact tier precedes a larger position score in a lower tier.", purpose: "coding",
    candidates: [record("direct", 0.001, { retrieval: { score: 0.001, channels: ["exact"], ranks: { exact: 2 }, exactTier: 1 } }), record("weak", 0.1)], expected: ["direct"], forbidden: ["weak"] },
  { id: "purpose-tie", rationale: "Coding task-state preference is allowed only after exact score/tier equality.", purpose: "coding",
    candidates: [record("weak", 0.02, { updatedAt: "2032-01-01T00:00:00.000Z" }), record("direct", 0.02, { kind: "task_state" })], expected: ["direct"], forbidden: ["weak"] },
  { id: "stable-id-tie", rationale: "With identical signals/time, use stable descending id, independent of input order.", purpose: "general",
    candidates: [record("a", 0.02), record("z", 0.02)], expected: ["z"], forbidden: ["a"] },
  { id: "missing-score", rationale: "Mixed scored/unscored evidence preserves upstream order, not a guessed score.", purpose: "coding",
    candidates: [record("direct", 0.01), record("weak", 0.5, { retrieval: undefined, kind: "task_state" })], expected: ["direct"], forbidden: ["weak"] },
];
