import { createHash } from "node:crypto";
import type { ParsedRecallInput, RecallResult, RetrievalChannel } from "../../../shared/types.js";
import { FACT_POLICY, resolveFacts } from "../../facts/resolution.js";
import { decodeRetrievalCursor, encodeRetrievalCursor } from "../../pagination/cursor.js";
import { retrievalFingerprint } from "../fingerprint.js";
import { fuseLegacyHits, type RetrieverHit } from "./fusion.js";
import type { LegacyRetrievalContext } from "./retrievers.js";

function uniqueChannels(channels: Iterable<RetrievalChannel>): RetrievalChannel[] {
  return [...new Set(channels)];
}

export async function recallLegacy(input: ParsedRecallInput, requireUserConfirmed: boolean, context: LegacyRetrievalContext): Promise<RecallResult> {

    const hits: RetrieverHit[][] = [];
    const channels: RetrievalChannel[] = [];

    const exactMemories = !context.enabledChannels.has("exact") || (input.key && input.key !== input.query)
      ? []
      : await context.retrievers.exact.retrieve(input);
    hits.push(exactMemories.map((memory) => ({ memory, channel: "exact" as const })));
    if (exactMemories.length > 0) channels.push("exact");

    const fullTextMemories = context.enabledChannels.has("full_text") ? await context.retrievers.fullText.retrieve(input) : [];

    if (context.enabledChannels.has("structured") && (input.key || input.kind || input.scope || input.taskId)) {
      const structuredMemories = await context.retrievers.structured.retrieve(input);
      const queryMatches = new Set([...exactMemories, ...fullTextMemories].map((memory) => memory.id));
      const structuredHits = structuredMemories.filter((memory) => queryMatches.has(memory.id));
      hits.push(structuredHits.map((memory) => ({ memory, channel: "structured" as const })));
      if (structuredHits.length > 0) channels.push("structured");
    }

    hits.push(fullTextMemories.map((memory) => ({ memory, channel: "full_text" as const })));
    if (fullTextMemories.length > 0) channels.push("full_text");

    let ranked = fuseLegacyHits(hits, context.rrfK);
    let factReview: NonNullable<RecallResult["retrieval"]>["factReview"];
    if (ranked.some(item => item.memory.fact)) {
      const resolved = await resolveFacts(ranked.map(item => ({ ...item, exactTier: 0,
        retrieval: { score: item.score, channels: uniqueChannels(item.channels), ranks: item.ranks } })), context.store, input,
        { requireUserConfirmed: requireUserConfirmed, groupLimit: context.factGroupLimit });
      const byId = new Map(resolved.ranked.map(item => [item.memory.id, item.retrieval]));
      ranked = ranked.filter(item => byId.has(item.memory.id)).map(item => ({ ...item, memory: { ...item.memory, retrieval: byId.get(item.memory.id) } }));
      factReview = resolved.review;
    }
    const fingerprint = createHash("sha256").update(JSON.stringify({ query: retrievalFingerprint(input), factPolicy: FACT_POLICY,
      groupLimit: context.factGroupLimit, requireUserConfirmed: requireUserConfirmed })).digest("base64url");
    const cursor = decodeRetrievalCursor(input.cursor, fingerprint);
    const afterCursor = cursor ? ranked.filter((item) => item.score < cursor.score
      || (item.score === cursor.score && (item.memory.updatedAt < cursor.timestamp
        || (item.memory.updatedAt === cursor.timestamp && item.memory.id < cursor.id)))) : ranked;
    const page = afterCursor.slice(0, input.limit + 1);
    const hasMore = page.length > input.limit;
    const pageItems = hasMore ? page.slice(0, input.limit) : page;
    const memories = pageItems.map((item) => ({
      ...item.memory,
      retrieval: { ...item.memory.retrieval, score: item.score, channels: uniqueChannels(item.channels), ranks: item.ranks },
    }));
    const last = pageItems.at(-1);
    return {
      memories,
      nextCursor: hasMore && last ? encodeRetrievalCursor(last.score, last.memory.updatedAt, last.memory.id, fingerprint) : null,
      retrieval: { mode: "hybrid", channels: uniqueChannels(channels), candidateCount: ranked.length, candidateLimit: context.candidateLimit, ...(factReview ? { factReview } : {}) },
    };
  }
