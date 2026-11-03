import type { ParsedRecallInput, ResolvedMemory, RetrievalChannel } from "../../../shared/types.js";
import type { StructuredMemoryInput } from "../../memory/storage-contract.js";
import type { MemoryRetriever, RetrievalSource } from "../contracts.js";

export interface LegacyRetrievalContext {
  store: RetrievalSource; retrievers: ReturnType<typeof createDefaultRetrievers>;
  enabledChannels: ReadonlySet<RetrievalChannel>; candidateLimit: number; rrfK: number; factGroupLimit: number;
}

function withoutCursor(input: ParsedRecallInput, candidateLimit: number): ParsedRecallInput {
  return { ...input, cursor: undefined, limit: candidateLimit };
}

class StoreRetriever implements MemoryRetriever {
  constructor(
    readonly channel: RetrievalChannel,
    private readonly store: RetrievalSource,
    private readonly buildInput: (input: ParsedRecallInput) => ParsedRecallInput,
  ) {}

  async retrieve(input: ParsedRecallInput): Promise<ResolvedMemory[]> {
    const request = this.buildInput(input);
    const result = request.query === undefined && this.store.list
      ? await this.store.list(request as StructuredMemoryInput)
      : await this.store.recall(request);
    return result.memories;
  }
}

export function createDefaultRetrievers(store: RetrievalSource, candidateLimit: number): { exact: MemoryRetriever; structured: MemoryRetriever; fullText: MemoryRetriever } {
  return {
    exact: new StoreRetriever("exact", store, (input) => ({ ...withoutCursor(input, candidateLimit), query: undefined, key: input.key && input.key !== input.query ? undefined : input.query })),
    structured: new StoreRetriever("structured", store, (input) => ({ ...withoutCursor(input, candidateLimit), query: undefined })),
    fullText: new StoreRetriever("full_text", store, (input) => ({ ...withoutCursor(input, candidateLimit), query: input.query })),
  };
}
