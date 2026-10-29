import { unscoredCandidate, type CandidateSearchInput, type CandidateSearchResult } from "../../../core/retrieval/contracts.js";
import { rowToMemory } from "../row-mapping.js";
import type { PostgresCandidateContext } from "./context.js";

/** PostgreSQL retains its declared match-order fallback, without extra extensions. */
export async function postgresCandidateResult(context: PostgresCandidateContext, input: CandidateSearchInput, clauses: string[], values: unknown[], implementation: CandidateSearchResult["implementation"]): Promise<CandidateSearchResult> {
  values.push(input.limit + 1);
  const rows = await context.rows(`SELECT * FROM memories_current WHERE ${clauses.join(" AND ")} ORDER BY updated_at DESC, id DESC LIMIT $${values.length}`, values);
  return { channel: input.channel, status: "ok", hits: rows.slice(0, input.limit).map((row, index) => unscoredCandidate(rowToMemory(row), input, index)),
    truncated: rows.length > input.limit, ordering: "updated_at_id", implementation };
}
