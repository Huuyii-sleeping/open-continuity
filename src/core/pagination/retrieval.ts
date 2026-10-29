import { OpenContinuityError } from "../../shared/errors.js";
import type { RetrievalCursorPayload } from "./contracts.js";
export function encodeRetrievalCursor(score: number, timestamp: string, id: string, fingerprint: string, exactTier?: number): string {
  return Buffer.from(JSON.stringify({ kind: "retrieval", score, timestamp, id, fingerprint, ...(exactTier !== undefined ? { version: 2 as const, exactTier } : {}) } satisfies RetrievalCursorPayload), "utf8").toString("base64url");
}
export function decodeRetrievalCursor(cursor: string | undefined, fingerprint: string, requireV2 = false): RetrievalCursorPayload | undefined {
  if (!cursor) return undefined;
  try {
    if (cursor.length > 4096 || !/^[A-Za-z0-9_-]+$/.test(cursor)) throw new Error("invalid encoding");
    const value = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8")) as Partial<RetrievalCursorPayload>;
    if (!value || value.kind !== "retrieval" || typeof value.score !== "number" || !Number.isFinite(value.score) || typeof value.timestamp !== "string"
      || typeof value.id !== "string" || !value.id || typeof value.fingerprint !== "string" || value.fingerprint !== fingerprint || Number.isNaN(Date.parse(value.timestamp))
      || (requireV2 && (value.version !== 2 || (value.exactTier !== 0 && value.exactTier !== 1)))) {
      throw new Error("invalid retrieval cursor payload");
    }
    return value as RetrievalCursorPayload;
  } catch {
    throw new OpenContinuityError("VALIDATION_ERROR", "Invalid retrieval pagination cursor", 400);
  }
}
