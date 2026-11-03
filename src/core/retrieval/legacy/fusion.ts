import type { ResolvedMemory, RetrievalChannel } from "../../../shared/types.js";

export interface RetrieverHit {
  memory: ResolvedMemory;
  channel: RetrievalChannel;
}

export interface RankedMemory {
  memory: ResolvedMemory;
  score: number;
  channels: Set<RetrievalChannel>;
  ranks: Partial<Record<RetrievalChannel, number>>;
}

function sortRanked(left: RankedMemory, right: RankedMemory): number {
  return right.score - left.score || right.memory.updatedAt.localeCompare(left.memory.updatedAt) || right.memory.id.localeCompare(left.memory.id);
}

export function fuseLegacyHits(hitLists: RetrieverHit[][], rrfK: number): RankedMemory[] {
    const ranked = new Map<string, RankedMemory>();
    for (const hitList of hitLists) {
      hitList.forEach((hit, index) => {
        const rank = index + 1;
        const current = ranked.get(hit.memory.id) ?? { memory: hit.memory, score: 0, channels: new Set<RetrievalChannel>(), ranks: {} };
        current.score += 1 / (rrfK + rank);
        current.channels.add(hit.channel);
        current.ranks[hit.channel] = rank;
        ranked.set(hit.memory.id, current);
      });
    }
    return [...ranked.values()].sort(sortRanked);
  }
