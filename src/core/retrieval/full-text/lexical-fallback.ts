/** Spelling-only, bounded fallback. These constants are part of retrieval cursor/capability policy. */
export const LEXICAL_FALLBACK_VERSION = "latin-one-edit-v1" as const;
export const LEXICAL_FALLBACK_LIMITS = Object.freeze({ maxQueryTerms: 8, minWordLength: 5, maxWordLength: 32,
  probeLimit: 100, maxTextBytes: 65536, maxTextTokens: 256 });
import type { WordCorrection, WordEdit } from "../contracts.js";
export type { WordCorrection, WordEdit } from "../contracts.js";

export function fallbackTerms(query: string): string[] | null {
  const trimmed = query.trim();
  if (!trimmed || !/^[a-zA-Z]+(?:\s+[a-zA-Z]+)*$/.test(trimmed)) return null;
  const terms = [...new Set(trimmed.toLowerCase().split(/\s+/))];
  return terms.length <= LEXICAL_FALLBACK_LIMITS.maxQueryTerms && terms.every(term => term.length <= LEXICAL_FALLBACK_LIMITS.maxWordLength)
    && terms.some(term => term.length >= LEXICAL_FALLBACK_LIMITS.minWordLength) ? terms : null;
}
/** Exactly one edit. Equality and multiple edits are deliberately not corrections. */
export function oneWordEdit(query: string, word: string): WordEdit | null {
  if (query === word || !/^[a-z]+$/.test(word) || Math.abs(query.length - word.length) > 1) return null;
  if (query.length === word.length) {
    const differences = [...query].flatMap((letter, index) => letter === word[index] ? [] : [index]);
    if (differences.length === 1) return "substitute";
    if (differences.length === 2) {
      const [a, b] = differences;
      if (b === a! + 1 && query[a!] === word[b!] && query[b!] === word[a!]) return "transpose";
    }
    return null;
  }
  const longer = query.length > word.length ? query : word, shorter = query.length > word.length ? word : query;
  let i = 0;
  while (i < shorter.length && longer[i] === shorter[i]) i++;
  return longer.slice(i + 1) === shorter.slice(i) ? query.length > word.length ? "delete" : "insert" : null;
}
export function wordTrigrams(word: string): string[] {
  return [...new Set(Array.from({ length: Math.max(0, word.length - 2) }, (_, index) => word.slice(index, index + 3)))];
}
export function verifySpelling(terms: string[], key: string, rawValue: string): { correction: WordCorrection | null; boundedOut: boolean } {
  const text = key + " " + rawValue;
  if (Buffer.byteLength(text, "utf8") > LEXICAL_FALLBACK_LIMITS.maxTextBytes) return { correction: null, boundedOut: true };
  const tokens = text.toLowerCase().match(/[a-z0-9]+/g) ?? [];
  if (tokens.length > LEXICAL_FALLBACK_LIMITS.maxTextTokens) return { correction: null, boundedOut: true };
  const words = new Set(tokens), missing = terms.filter(term => !words.has(term));
  if (missing.length !== 1 || missing[0]!.length < LEXICAL_FALLBACK_LIMITS.minWordLength) return { correction: null, boundedOut: false };
  const queryToken = missing[0]!;
  // Deterministic lexical tie-break for multiple possible spelling corrections; not semantic disambiguation.
  for (const matchedToken of [...words].sort()) {
    const edit = oneWordEdit(queryToken, matchedToken);
    if (edit) return { correction: { queryToken, matchedToken, edit }, boundedOut: false };
  }
  return { correction: null, boundedOut: false };
}
