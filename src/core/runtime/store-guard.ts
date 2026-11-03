import { retrievalChannelSchema, type RetrievalChannel } from "../../shared/types.js";
import type { MemoryStore } from "../memory/contracts.js";
import type { CandidateReader, CandidateReaderSet } from "../retrieval/contracts.js";
import type { ReadStage } from "./contracts.js";
export type GuardedRead = <T>(stage: ReadStage, start: () => T | Promise<T>) => Promise<T>;
export function guardMemoryStore(store: MemoryStore, readStore: GuardedRead): MemoryStore {
  const readers = store.candidateReaders;
  const wrapped: Partial<Record<RetrievalChannel, CandidateReader>> = {};
  if (readers) for (const channel of retrievalChannelSchema.options) {
    const read = readers[channel];
    if (read) wrapped[channel] = input => readStore("candidates", () => read.call(readers, input));
  }
  const candidateReaders: CandidateReaderSet = Object.freeze(wrapped);
  return {
    ...(store.handoffReviewVersion ? { handoffReviewVersion: store.handoffReviewVersion } : {}),
    ...(store.lexicalIndexVersion ? { lexicalIndexVersion: store.lexicalIndexVersion } : {}),
    ...(store.lexicalFallbackVersion ? { lexicalFallbackVersion: store.lexicalFallbackVersion } : {}),
    appendRemember: input => store.appendRemember(input), appendForget: (...args) => store.appendForget(...args),
    recall: input => readStore("lookup", () => store.recall(input)), history: input => readStore("history", () => store.history(input)),
    ...(store.list ? { list: input => readStore("list", () => store.list!(input)) } : {}),
    ...(store.searchCandidates ? { searchCandidates: input => readStore("candidates", () => store.searchCandidates!(input)) } : {}),
    ...(readers ? { candidateReaders } : {}),
    ...(store.readFactGroup ? { readFactGroup: input => readStore("fact_group", () => store.readFactGroup!(input)) } : {}),
    ...(store.close ? { close: () => store.close!() } : {}),
  };
}
