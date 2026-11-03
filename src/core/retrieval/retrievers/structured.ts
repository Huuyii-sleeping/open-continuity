import type { CandidateReader, CandidateRetrievalRequest, CandidateRetriever } from "../contracts.js";
import { channelResult } from "./result.js";

export class StructuredCandidateRetriever implements CandidateRetriever {
  readonly channel = "structured" as const;
  constructor(private readonly read: CandidateReader) {}
  async retrieve(input: CandidateRetrievalRequest) {
    const { lexicalFallback: _fallback, ...request } = input;
    return channelResult(await this.read(request), this.channel);
  }
}
