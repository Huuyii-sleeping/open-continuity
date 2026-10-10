import type { MemoryKind, Sensitivity } from "../shared/types.js";

export type CaptureSource = string;
export type CaptureQuality = "complete" | "partial" | "interrupted";
export type CaptureTurnStatus = "completed" | "failed" | "interrupted" | "in_progress" | "unknown";
export type ConversationItemType = "user_message" | "assistant_message" | "tool_call" | "compaction" | "other";

export interface ConversationItem {
  id: string;
  type: ConversationItemType;
  phase?: "commentary" | "final_answer";
  text?: string;
  toolName?: string;
  toolInput?: unknown;
  toolOutput?: unknown;
  toolStatus?: string;
  rawType: string;
  sensitive?: boolean;
  redacted?: boolean;
}

export interface ConversationTurn {
  id: string;
  status: CaptureTurnStatus;
  quality: CaptureQuality;
  startedAt?: string;
  completedAt?: string;
  items: ConversationItem[];
}

export interface ConversationThread {
  source: CaptureSource;
  id: string;
  sessionId: string;
  cwd: string;
  cliVersion: string;
  ephemeral: boolean;
  createdAt: string;
  updatedAt: string;
  preview: string;
  turns: ConversationTurn[];
}

export type CandidateStatus = "pending" | "approved" | "rejected";
export type CandidateReviewAction = "create" | "link_duplicate" | "replace_required";

export interface CandidateMemoryMatch {
  memoryId: string;
  key: string;
  value: unknown;
  version: number;
  sourceEventId: string;
  similarity: number;
}

export interface CandidateReview {
  action: CandidateReviewAction;
  matches: CandidateMemoryMatch[];
}

export interface MemoryCandidate {
  id: string;
  source: CaptureSource;
  threadId: string;
  turnId: string;
  itemId: string;
  kind: MemoryKind;
  key: string;
  value: string;
  evidence: string;
  rationale: string;
  confidence: number;
  dedupeKey: string;
  occurrenceCount: number;
  lastSeenAt: string;
  sensitivity: Sensitivity;
  captureQuality: CaptureQuality;
  status: CandidateStatus;
  createdAt: string;
  reviewedAt?: string;
  memoryEventId?: string;
  review?: CandidateReview;
}

export interface CaptureSyncResult {
  source: CaptureSource;
  threadsSeen: number;
  threadsImported: number;
  turnsImported: number;
  itemsImported: number;
  candidatesCreated: number;
  skippedEphemeral: number;
  skippedNotAllowed?: number;
  skippedUnchanged?: number;
  sensitiveItemsRedacted?: number;
  candidatesBlockedSensitive?: number;
  pagesScanned?: number;
  warning?: string;
}

export interface CaptureCheckpoint {
  source: CaptureSource;
  threadId: string;
  threadUpdatedAt: string;
  lastTurnId?: string;
  lastItemId?: string;
  lastItemCount: number;
  syncedAt: string;
}

export interface CaptureCheckpointStatus {
  threads: number;
  trackedItems: number;
  latestSyncedAt?: string;
  latestThreadUpdatedAt?: string;
}
