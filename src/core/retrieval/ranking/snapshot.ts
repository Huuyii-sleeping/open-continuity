import type { ResolvedMemory } from "../../../shared/types.js";
export function snapshot(memory: ResolvedMemory) { const { retrieval: _retrieval, ...current } = memory; return current; }
