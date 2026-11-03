import type { SQLInputValue } from "node:sqlite";
import { unscoredCandidate, type CandidateSearchInput, type CandidateSearchResult } from "../../../core/retrieval/contracts.js";
import { rowToMemory } from "../row-mapping.js";
import type { SqliteCandidateContext } from "./context.js";

/** Stable unscored listing, shared by exact-key and structured readers. */
export function sqliteLookupCandidates(context: SqliteCandidateContext, input: CandidateSearchInput, clauses: string[], values: SQLInputValue[]): CandidateSearchResult {
  try {
    const rows = context.all(`SELECT m.* FROM memories_current m WHERE ${clauses.join(" AND ")} ORDER BY m.updated_at DESC, m.id DESC LIMIT ?`, [...values, input.limit + 1]);
    return { channel: input.channel, status: "ok", hits: rows.slice(0, input.limit).map((row, index) => unscoredCandidate(rowToMemory(row), input, index)),
      truncated: rows.length > input.limit, ordering: "updated_at_id", implementation: "structured_lookup" };
  } catch (error) { throw context.storageError(error); }
}
