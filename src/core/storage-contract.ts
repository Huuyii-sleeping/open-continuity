import { createHash } from "node:crypto";
import { OpenContinuityError } from "../shared/errors.js";
import type { HistoryResult, ParsedHistoryInput, ParsedRecallInput, ParsedRememberInput, RecallResult, ResolvedMemory } from "../shared/types.js";
import type { MemoryReceiptLike } from "./memory-store.js";

export type StorageResult<T> = T | Promise<T>;
export type StructuredMemoryInput = Omit<ParsedRecallInput, "query"> & { query?: never };

/** Persistence owns eligibility, atomic current/event writes and chronological pagination. */
export interface MemoryPersistence {
  appendRemember(input: ParsedRememberInput): StorageResult<MemoryReceiptLike>;
  appendForget(userId: string, agentId: string, memoryId: string, taskId?: string, includePrivate?: boolean): StorageResult<MemoryReceiptLike>;
  history(input: ParsedHistoryInput): StorageResult<HistoryResult>;
  close?(): StorageResult<void>;
}
export interface MemoryRepository extends MemoryPersistence {
  list(input: StructuredMemoryInput): StorageResult<RecallResult>;
}
/** Compatibility lookup, not a relevance ranking contract. Native query semantics may differ. */
export interface LegacyMemoryLookup {
  recall(input: ParsedRecallInput): StorageResult<RecallResult>;
}

export function assertStructuredInput(input: StructuredMemoryInput): void {
  if (input.query !== undefined) throw new OpenContinuityError("VALIDATION_ERROR", "Structured storage listing does not accept query", 400);
}

export function memoryIdentity(input: Pick<ParsedRememberInput, "userId" | "scope" | "taskId" | "agentId" | "key">): string {
  return JSON.stringify([input.userId, input.scope, input.scope === "task" ? input.taskId : input.scope === "agent" ? input.agentId : null, input.key]);
}
export function storedMemoryIdentity(userId: string, memory: ResolvedMemory): string {
  return memoryIdentity({ userId, scope: memory.scope, taskId: memory.taskId, agentId: memory.ownerAgentId ?? memory.sourceAgentId, key: memory.key });
}
export function storageFingerprint(input: ParsedRecallInput | ParsedHistoryInput, kind: "memory" | "event"): string {
  const base = { protocol: "storage-cursor-v2", kind, userId: input.userId, agentId: input.agentId, taskId: input.taskId ?? null, includePrivate: input.includePrivate };
  const filters = kind === "memory" ? {
    key: (input as ParsedRecallInput).key ?? null, scope: (input as ParsedRecallInput).scope ?? null,
    memoryKind: (input as ParsedRecallInput).kind ?? null, query: (input as ParsedRecallInput).query ?? null,
  } : { memoryId: (input as ParsedHistoryInput).memoryId ?? null };
  return createHash("sha256").update(JSON.stringify({ ...base, ...filters })).digest("base64url");
}
