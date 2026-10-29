import type { ResolvedMemory } from "../../shared/types.js";
export function resolveFactReferences(active: ResolvedMemory[], byId: Map<string, ResolvedMemory>) {
  const edges = new Map<string, string[]>();
  let unresolved = false;
  for (const memory of active) {
    const targets: string[] = [];
    for (const ref of memory.fact!.supersedes) {
      const target = byId.get(ref.memoryId);
      if (!target || target.sourceEventId !== ref.sourceEventId || target.version !== ref.version) unresolved = true;
      else targets.push(target.id);
    }
    edges.set(memory.id, targets);
  }
  const visiting = new Set<string>(), visited = new Set<string>();
  function cycle(id: string): boolean {
    if (visiting.has(id)) return true;
    if (visited.has(id)) return false;
    visiting.add(id);
    for (const target of edges.get(id) ?? []) if (cycle(target)) return true;
    visiting.delete(id); visited.add(id); return false;
  }
  const cyclic = active.some(memory => cycle(memory.id));
  return { unresolved, cyclic, replaced: new Set([...edges.values()].flat()) };
}
