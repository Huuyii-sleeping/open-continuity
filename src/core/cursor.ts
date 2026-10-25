import { OpenContinuityError } from "../shared/errors.js";

export type CursorKind = "memory" | "event" | "retrieval";

interface CursorPayload {
  kind: CursorKind;
  timestamp: string;
  id: string;
  version?: 2;
  fingerprint?: string;
}

interface RetrievalCursorPayload {
  kind: "retrieval";
  version?: 2;
  exactTier?: number;
  score: number;
  timestamp: string;
  id: string;
  fingerprint: string;
}

export function encodeCursor(kind: CursorKind, timestamp: string, id: string, fingerprint?: string): string {
  return Buffer.from(JSON.stringify({ kind, timestamp, id, ...(fingerprint ? { version: 2 as const, fingerprint } : {}) } satisfies CursorPayload), "utf8").toString("base64url");
}

export function decodeCursor(cursor: string | undefined, expectedKind: CursorKind, fingerprint?: string): CursorPayload | undefined {
  if (!cursor) return undefined;
  try {
    if (cursor.length > 4096 || !/^[A-Za-z0-9_-]+$/.test(cursor)) throw new Error("invalid encoding");
    const value = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8")) as Partial<CursorPayload>;
    if (!value || value.kind !== expectedKind || typeof value.timestamp !== "string" || typeof value.id !== "string" || !value.id || Number.isNaN(Date.parse(value.timestamp))) {
      throw new Error("invalid cursor payload");
    }
    if (fingerprint && (value.version !== 2 || value.fingerprint !== fingerprint)) {
      throw new OpenContinuityError("VALIDATION_ERROR", "Invalid pagination cursor; restart pagination with the current filters", 400, { reason: value.version === undefined ? "legacy_cursor_restart_required" : "cursor_filter_mismatch" });
    }
    return value as CursorPayload;
  } catch (error) {
    if (error instanceof OpenContinuityError) throw error;
    throw new OpenContinuityError("VALIDATION_ERROR", "Invalid pagination cursor", 400);
  }
}

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
