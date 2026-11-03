import type { ResolvedMemory } from "../../../shared/types.js";

export interface InMemoryCandidateContext {
  current(): Iterable<ResolvedMemory>;
  belongsToUser(memory: ResolvedMemory, userId: string): boolean;
  isVisible(memory: ResolvedMemory, agentId: string, taskId?: string): boolean;
}
