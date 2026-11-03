export type CursorKind = "memory" | "event" | "retrieval";
export interface CursorPayload {
  kind: CursorKind;
  timestamp: string;
  id: string;
  version?: 2;
  fingerprint?: string;
}
export interface RetrievalCursorPayload {
  kind: "retrieval";
  version?: 2;
  exactTier?: number;
  score: number;
  timestamp: string;
  id: string;
  fingerprint: string;
}
