import type { ResolvedMemory } from "../shared/types.js";
import type { CandidateMemoryMatch, CandidateReview, MemoryCandidate } from "./types.js";

function normalized(value: unknown): string {
  const text = typeof value === "string" ? value : JSON.stringify(value);
  return (text ?? "").normalize("NFKC").toLocaleLowerCase().replace(/[\p{P}\p{S}\s]+/gu, "");
}

function ngrams(value: string, size: number): Set<string> {
  if (value.length <= size) return new Set(value ? [value] : []);
  const values = new Set<string>();
  for (let index = 0; index <= value.length - size; index += 1) values.add(value.slice(index, index + size));
  return values;
}

export function candidateSimilarity(left: unknown, right: unknown): number {
  const a = normalized(left);
  const b = normalized(right);
  if (!a || !b) return 0;
  if (a === b) return 1;
  const leftGrams = ngrams(a, 2);
  const rightGrams = ngrams(b, 2);
  let intersection = 0;
  for (const value of leftGrams) if (rightGrams.has(value)) intersection += 1;
  return Number(((2 * intersection) / (leftGrams.size + rightGrams.size)).toFixed(6));
}

function match(memory: ResolvedMemory, similarity: number): CandidateMemoryMatch {
  return {
    memoryId: memory.id,
    key: memory.key,
    value: memory.value,
    version: memory.version,
    sourceEventId: memory.sourceEventId,
    similarity,
  };
}

export function reviewMemoryCandidate(candidate: MemoryCandidate, memories: ResolvedMemory[]): CandidateReview {
  const matches = memories.filter((memory) => memory.kind === candidate.kind)
    .map((memory) => match(memory, candidateSimilarity(candidate.value, memory.value)))
    .filter((entry) => entry.similarity >= 0.72)
    .sort((left, right) => right.similarity - left.similarity || right.version - left.version)
    .slice(0, 5);
  const exact = matches.filter((entry) => entry.similarity === 1);
  if (exact.length) return { action: "link_duplicate", matches: exact };
  if (matches.length) return { action: "replace_required", matches };
  return { action: "create", matches: [] };
}
