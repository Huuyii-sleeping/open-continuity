import type { CandidateReaderSet } from "../../../core/retrieval/contracts.js";
import type { PostgresCandidateContext } from "./context.js";
import { postgresExactCandidates } from "./exact.js";
import { postgresStructuredCandidates } from "./structured.js";
import { postgresFullTextCandidates } from "./full-text.js";

export function createPostgresCandidateReaders(context: PostgresCandidateContext): CandidateReaderSet {
  return Object.freeze({
    exact: input => postgresExactCandidates(context, input),
    structured: input => postgresStructuredCandidates(context, input),
    full_text: input => postgresFullTextCandidates(context, input),
  });
}
