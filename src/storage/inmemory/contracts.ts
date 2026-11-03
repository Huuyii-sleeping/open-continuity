import type { MemoryReceiptLike } from "../../core/memory/contracts.js";
import type { MemoryEvent, ResolvedMemory } from "../../shared/types.js";
export interface InMemoryState { readonly events: MemoryEvent[]; readonly resolved: Map<string, ResolvedMemory>; readonly idempotency: Map<string, MemoryReceiptLike>; readonly eventOwners: Map<string, string>; }
export interface InMemoryOperations { readonly state: InMemoryState; belongsToUser(memory: ResolvedMemory, userId: string): boolean; isVisible(memory: ResolvedMemory, agentId: string, taskId?: string): boolean; }
