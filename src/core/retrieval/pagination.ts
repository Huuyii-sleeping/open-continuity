import { decodeRetrievalCursor, encodeRetrievalCursor } from "../pagination/cursor.js";
import type { RankedEvidence } from "./contracts.js";
export function paginateRankedEvidence(ranked: RankedEvidence[], cursor: ReturnType<typeof decodeRetrievalCursor>, limit: number, fingerprint: string) {
  const remaining = cursor ? ranked.filter(item => item.exactTier < cursor.exactTier!
    || (item.exactTier === cursor.exactTier && (item.score < cursor.score || (item.score === cursor.score
      && (item.memory.updatedAt < cursor.timestamp || (item.memory.updatedAt === cursor.timestamp && item.memory.id < cursor.id)))))) : ranked;
  const page = remaining.slice(0, limit), last = page.at(-1);
  return { page, nextCursor: remaining.length > limit && last ? encodeRetrievalCursor(last.score, last.memory.updatedAt, last.memory.id, fingerprint, last.exactTier) : null };
}
