import type { ResolvedMemory } from "../../shared/types.js";
export function estimateContextTokens(text: string): number {
  return text.length === 0 ? 0 : Math.max(1, Math.ceil(Buffer.byteLength(text, "utf8") / 4));
}
export function renderMemory(memory: ResolvedMemory): string {
  return JSON.stringify({
    key: memory.key, value: memory.value, kind: memory.kind, scope: memory.scope, version: memory.version, ...(memory.taskId ? { taskId: memory.taskId } : {}), ...(memory.confidence ? { confidence: memory.confidence } : {}),
    ...(memory.fact ? { fact: { group: memory.fact.group, validFrom: memory.fact.validFrom, validUntil: memory.fact.validUntil, status: memory.retrieval?.factAssessment?.status ?? "unresolved" } } : {})
  });
}
