import type { CandidateReader, CandidateRetrievalRequest, CandidateRetriever } from "../contracts.js";
import { channelResult } from "./result.js";

export class FullTextCandidateRetriever implements CandidateRetriever {
  readonly channel = "full_text" as const;
  constructor(private readonly read: CandidateReader) {}
  async retrieve(input: CandidateRetrievalRequest) {
    const { lexicalFallback, ...request } = input;
    return channelResult(await this.read({ ...request, ...(lexicalFallback ? { lexicalFallback: true } : {}) }), this.channel);
  }
}
