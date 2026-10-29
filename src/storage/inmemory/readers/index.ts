import type { BuiltinSyncCandidateReaders } from "../../../core/retrieval/contracts.js";
import type { InMemoryCandidateContext } from "./context.js";
import { inMemoryExactCandidates } from "./exact.js";
import { inMemoryStructuredCandidates } from "./structured.js";
import { inMemoryFullTextCandidates } from "./full-text.js";

export function createInMemoryCandidateReaders(context: InMemoryCandidateContext): BuiltinSyncCandidateReaders {
  return Object.freeze<BuiltinSyncCandidateReaders>({
    exact: input => inMemoryExactCandidates(context, input),
    structured: input => inMemoryStructuredCandidates(context, input),
    full_text: input => inMemoryFullTextCandidates(context, input),
  });
}
