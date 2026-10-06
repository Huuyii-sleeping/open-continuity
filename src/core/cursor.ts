import { OpenContinuityError } from "../shared/errors.js";

export type CursorKind = "memory" | "event" | "retrieval";

interface CursorPayload {
  kind: CursorKind;
  timestamp: string;
  id: string;
}

interface RetrievalCursorPayload {
  kind: "retrieval";
  score: number;
  timestamp: string;
  id: string;
  fingerprint: string;
}

export function encodeCursor(kind: CursorKind, timestamp: string, id: string): string {
  return Buffer.from(JSON.stringify({ kind, timestamp, id } satisfies CursorPayload), "utf8").toString("base64url");
}

export function decodeCursor(cursor: string | undefined, expectedKind: CursorKind): CursorPayload | undefined {
  if (!cursor) return undefined;
  try {
    const value = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8")) as Partial<CursorPayload>;
    if (value.kind !== expectedKind || typeof value.timestamp !== "string" || typeof value.id !== "string" || Number.isNaN(Date.parse(value.timestamp))) {
      throw new Error("invalid cursor payload");
    }
    return value as CursorPayload;
  } catch {
    throw new OpenContinuityError("VALIDATION_ERROR", "Invalid pagination cursor", 400);
  }
}

export function encodeRetrievalCursor(score: number, timestamp: string, id: string, fingerprint: string): string {
  return Buffer.from(JSON.stringify({ kind: "retrieval", score, timestamp, id, fingerprint } satisfies RetrievalCursorPayload), "utf8").toString("base64url");
}

export function decodeRetrievalCursor(cursor: string | undefined, fingerprint: string): RetrievalCursorPayload | undefined {
  if (!cursor) return undefined;
  try {
    const value = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8")) as Partial<RetrievalCursorPayload>;
    if (value.kind !== "retrieval" || typeof value.score !== "number" || !Number.isFinite(value.score) || typeof value.timestamp !== "string"
      || typeof value.id !== "string" || typeof value.fingerprint !== "string" || value.fingerprint !== fingerprint || Number.isNaN(Date.parse(value.timestamp))) {
      throw new Error("invalid retrieval cursor payload");
    }
    return value as RetrievalCursorPayload;
  } catch {
    throw new OpenContinuityError("VALIDATION_ERROR", "Invalid retrieval pagination cursor", 400);
  }
}
