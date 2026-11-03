import type { ParsedHandoffCreateInput } from "../../../shared/types.js";

export const HANDOFF_REVIEW_VERSION = "handoff-review-v1" as const;
export const HANDOFF_REVIEW_METADATA = "openContinuityHandoffReview";
export interface HandoffSnapshot { memoryId: string | null; sourceEventId: string | null; version: number; }
export interface HandoffDraft {
  version: typeof HANDOFF_REVIEW_VERSION;
  draftId: string;
  preparedAt: string;
  reviewExpiresAt: string;
  input: ParsedHandoffCreateInput;
  expectedSnapshot: HandoffSnapshot;
  fingerprint: string;
}
export interface HandoffWriteReview {
  version: typeof HANDOFF_REVIEW_VERSION;
  draftFingerprint: string;
  userId: string;
  agentId: string;
  taskId: string;
  expectedSnapshot: HandoffSnapshot;
}
