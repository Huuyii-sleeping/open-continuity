import { candidateFilters, candidateQuery, parseCandidateSearch, skippedCandidates, unscoredCandidate, type CandidateRetrievalRequest, type CandidateSearchResult, type ScoredSearchHit } from "../../../core/retrieval/contracts.js";
import { LEXICAL_FALLBACK_VERSION } from "../../../core/retrieval/full-text/lexical-fallback.js";
import { rowToMemory } from "../row-mapping.js";
import type { SqliteCandidateContext } from "./context.js";
import { sqliteCandidateEligibility } from "./eligibility.js";
import { ftsPhrase } from "./fts.js";
import { sqliteSpellingCandidates } from "./spelling.js";

export function sqliteFullTextCandidates(context: SqliteCandidateContext, request: CandidateRetrievalRequest): CandidateSearchResult {
  context.assertOpen();
  const input = parseCandidateSearch({ ...request, channel: "full_text" }), skipped = skippedCandidates(input);
  if (skipped) return skipped;
  const { clauses, values } = sqliteCandidateEligibility(input);
  const eligibilityClauses = [...clauses], eligibilityValues = [...values];
  const terms = [...new Set(candidateQuery(input).split(/\s+/u))];
  const longTerms = terms.filter(term => [...term].length >= 3);
  const bm25 = longTerms.length > 0;
  const lexicalIndexVersion = context.lexicalIndexVersion?.();
  const projection = Boolean(lexicalIndexVersion);
  if (bm25) { clauses.push("memories_fts MATCH ?"); values.push(longTerms.map(ftsPhrase).join(" AND ")); }
  for (const term of bm25 ? terms.filter(term => [...term].length < 3) : terms) {
    clauses.push(`(instr(lower(m.memory_key), lower(?)) > 0 OR instr(lower(${projection ? "memories_fts.value_text" : "m.value"}), lower(?)) > 0)`); values.push(term, term);
  }
  values.push(input.limit + 1);
  const from = bm25 ? "memories_fts JOIN memories_current m ON m.id = memories_fts.memory_id"
    : projection ? "memories_current m JOIN memory_fts_keys k ON k.memory_id = m.id JOIN memories_fts ON memories_fts.rowid = k.rowid" : "memories_current m";
  try {
    const rows = context.all(`SELECT m.*${bm25 ? ", bm25(memories_fts) AS candidate_score" : ""} FROM ${from} WHERE ${clauses.join(" AND ")} ORDER BY ${bm25 ? "candidate_score ASC, " : ""}m.updated_at DESC, m.id DESC LIMIT ?`, values);
    if (input.lexicalFallback && rows.length === 0) return sqliteSpellingCandidates(context, input, eligibilityClauses, eligibilityValues);
    const hits = rows.slice(0, input.limit).map((row, index): ScoredSearchHit => {
      const memory = rowToMemory(row);
      if (!bm25) {
        const hit = unscoredCandidate(memory, input, index);
        if (terms.length > 1) hit.match = { type: "lexical_terms", reason: "all_literal_terms", filters: candidateFilters(input), termCount: terms.length };
        return hit;
      }
      const score = Number(row.candidate_score);
      if (!Number.isFinite(score)) throw new Error("invalid BM25 score");
      return { memory, channel: input.channel, channelRank: index + 1, rankMeaning: "relevance", score: { model: "fts5_bm25", value: score, direction: "lower_is_better" },
        match: { type: "lexical_terms", reason: "all_literal_terms", filters: candidateFilters(input), termCount: terms.length } };
    });
    return { channel: input.channel, status: "ok", hits, truncated: rows.length > input.limit, ordering: bm25 ? "bm25_then_updated_at_id" : "updated_at_id",
      implementation: bm25 ? "sqlite_fts5_bm25" : "sqlite_literal_fallback",
      ...(lexicalIndexVersion ? { lexicalIndexVersion } : {}),
      ...(input.lexicalFallback ? { lexicalFallback: { version: LEXICAL_FALLBACK_VERSION, used: false, reason: "literal_hit" as const,
        probes: 0, inspected: 0, boundedOut: 0, probeLimit: 100 as const, truncated: false } } : {}) };
  } catch (error) { throw context.storageError(error); }
}
