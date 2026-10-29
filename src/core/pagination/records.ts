import { OpenContinuityError } from "../../shared/errors.js";
import type { CursorKind, CursorPayload } from "./contracts.js";
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
