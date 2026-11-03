import { OpenContinuityError } from "../../shared/errors.js";
import { retrievalChannelSchema, type RetrievalChannel } from "../../shared/types.js";
import { parseCandidateSearch, type CandidateReaderSet, type CandidateRetrievalRequest, type CandidateRetriever, type CandidateSearchResult, type CandidateSearchStore } from "./contracts.js";
import { legacyCandidateReaders } from "./legacy/candidate-readers.js";
import { ExactCandidateRetriever } from "./retrievers/exact.js";
import { StructuredCandidateRetriever } from "./retrievers/structured.js";
import { FullTextCandidateRetriever } from "./retrievers/full-text.js";

/** Composition and bounded execution only. Each retriever owns one independent reader. */
export class CandidateRetrieval {
  private readonly retrievers: Readonly<Partial<Record<RetrievalChannel, CandidateRetriever>>>;
  constructor(source: CandidateSearchStore | CandidateReaderSet) {
    // Passing a legacy facade deliberately preserves wrappers/overrides and their observations.
    // A caller can select the independent reader interface by passing the reader set itself.
    const readers = "searchCandidates" in source ? legacyCandidateReaders(source) : source;
    this.retrievers = Object.freeze({
      ...(readers.exact ? { exact: new ExactCandidateRetriever(readers.exact.bind(readers)) } : {}),
      ...(readers.structured ? { structured: new StructuredCandidateRetriever(readers.structured.bind(readers)) } : {}),
      ...(readers.full_text ? { full_text: new FullTextCandidateRetriever(readers.full_text.bind(readers)) } : {}),
    });
  }
  assertChannelsAvailable(channels: readonly RetrievalChannel[]): void {
    if (channels.some(channel => !this.retrievers[channel])) {
      throw new OpenContinuityError("VALIDATION_ERROR", "Candidate reader is not registered", 400);
    }
  }
  async retrieve(input: CandidateRetrievalRequest, channels: readonly RetrievalChannel[] = ["exact", "structured", "full_text"]): Promise<CandidateSearchResult[]> {
    if (!channels.length || new Set(channels).size !== channels.length || channels.some(channel => !retrievalChannelSchema.safeParse(channel).success)) {
      throw new OpenContinuityError("VALIDATION_ERROR", "Specify unique candidate channels", 400);
    }
    this.assertChannelsAvailable(channels);
    const { channel: _channel, ...request } = parseCandidateSearch({ ...input, channel: channels[0]! });
    const results: CandidateSearchResult[] = [];
    for (const channel of channels) results.push(await this.retrievers[channel]!.retrieve(request));
    return results;
  }
}
