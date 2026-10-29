import type { SQLInputValue } from "node:sqlite";
import { candidateFilters, candidateQuery, type CandidateSearchInput, type CandidateSearchResult, type LexicalFallbackReceipt, type ScoredSearchHit } from "../../../core/retrieval/contracts.js";
import { fallbackTerms, verifySpelling, wordTrigrams, LEXICAL_FALLBACK_VERSION, LEXICAL_FALLBACK_LIMITS } from "../../../core/retrieval/full-text/lexical-fallback.js";
import { rowToMemory } from "../row-mapping.js";
import type { SqliteCandidateContext } from "./context.js";
import { ftsPhrase } from "./fts.js";

export function sqliteSpellingCandidates(context: SqliteCandidateContext, input: CandidateSearchInput, eligibility: string[], parameters: SQLInputValue[]): CandidateSearchResult {
    const terms = fallbackTerms(candidateQuery(input));
    const receipt: LexicalFallbackReceipt = { version: LEXICAL_FALLBACK_VERSION, used: Boolean(terms), reason: terms ? "literal_miss" : "unsupported_query",
      probes: 0, inspected: 0, boundedOut: 0, probeLimit: 100, truncated: false };
    const matched = new Map<string, ScoredSearchHit>(), seen = new Set<string>();
    if (terms) for (let position = 0; position < terms.length; position++) {
      const word = terms[position]!;
      if (word.length < LEXICAL_FALLBACK_LIMITS.minWordLength) continue;
      if (receipt.inspected >= receipt.probeLimit) { receipt.truncated = true; break; }
      const match = terms.flatMap((term, index) => index === position ? ["(" + wordTrigrams(term).map(ftsPhrase).join(" OR ") + ")"] : term.length >= 3 ? [ftsPhrase(term)] : []).join(" AND ");
      const shortClauses: string[] = [], shortParameters: SQLInputValue[] = [];
      for (const term of terms.filter((term, index) => index !== position && term.length < 3)) {
        shortClauses.push("(instr(lower(m.memory_key), ?) > 0 OR instr(lower(m.value), ?) > 0)"); shortParameters.push(term, term);
      }
      const remaining = receipt.probeLimit - receipt.inspected;
      // CASE bounds materialized key/value bytes before they leave SQL. Full values are never truncated into evidence.
      const bytes = "length(CAST(m.memory_key AS BLOB)) + length(CAST(m.value AS BLOB))";
      const columns = "m.id,m.kind,m.scope,m.task_id,m.owner_agent_id,m.sensitivity,m.user_confirmed,m.source_event_id,m.source_agent_id,m.updated_at,m.version,m.supersedes_event_id,m.supersedes_version,m.confidence,m.confidence_basis,m.fact";
      const rows = context.all(`SELECT ${columns}, CASE WHEN ${bytes} <= ${LEXICAL_FALLBACK_LIMITS.maxTextBytes} THEN m.memory_key ELSE NULL END AS memory_key,
        CASE WHEN ${bytes} <= ${LEXICAL_FALLBACK_LIMITS.maxTextBytes} THEN m.value ELSE NULL END AS value
        FROM memories_fts JOIN memories_current m ON m.id = memories_fts.memory_id
        WHERE ${[...eligibility, ...shortClauses].join(" AND ")} AND memories_fts MATCH ? ORDER BY bm25(memories_fts),m.updated_at DESC,m.id DESC LIMIT ?`,
      [...parameters, ...shortParameters, match, remaining + 1]);
      receipt.probes++;
      if (rows.length > remaining) receipt.truncated = true;
      for (const row of rows.slice(0, remaining)) {
        const id = String(row.id);
        receipt.inspected++;
        if (seen.has(id)) continue;
        seen.add(id);
        if (row.memory_key === null || row.value === null) { receipt.boundedOut++; receipt.truncated = true; continue; }
        const verified = verifySpelling(terms, String(row.memory_key), String(row.value));
        if (verified.boundedOut) { receipt.boundedOut++; receipt.truncated = true; }
        if (!verified.correction) continue;
        matched.set(id, { memory: rowToMemory(row), channel: "full_text", channelRank: 0, rankMeaning: "relevance",
          score: { model: "token_edit_distance", value: 1, direction: "lower_is_better" },
          match: { type: "one_edit_terms", reason: "all_terms_one_edit", filters: candidateFilters(input), termCount: terms.length, correction: verified.correction } });
      }
    }
    const ranked = [...matched.values()].sort((a, b) => b.memory.updatedAt.localeCompare(a.memory.updatedAt) || b.memory.id.localeCompare(a.memory.id));
    return { channel: "full_text", status: "ok", implementation: "sqlite_one_edit_fallback", ordering: "edit_distance_then_updated_at_id",
      hits: ranked.slice(0, input.limit).map((hit, index) => ({ ...hit, channelRank: index + 1 })), truncated: receipt.truncated || ranked.length > input.limit, lexicalFallback: receipt };
  }
