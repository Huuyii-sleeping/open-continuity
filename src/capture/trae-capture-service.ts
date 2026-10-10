import type { LocalConfig } from "../cli/config.js";
import { loadConfig } from "../cli/config.js";
import { ConversationInbox } from "./conversation-inbox.js";
import { probeTraeCapture, TraeAppServerClient, type TraeCaptureCapabilities } from "./trae-app-server.js";
import type { CaptureSyncResult, MemoryCandidate } from "./types.js";
import type { Sensitivity } from "../shared/types.js";
import { acquireCaptureLock } from "./capture-lock.js";
import { syncCaptureAdapter } from "./capture-adapter-service.js";
import { captureDatabasePath } from "./paths.js";

export { captureDatabasePath } from "./paths.js";

export function captureStatus(env: NodeJS.ProcessEnv = process.env, source = "trae") {
  const inbox = new ConversationInbox(captureDatabasePath(env));
  try { return { source, inboxPath: captureDatabasePath(env), sync: inbox.readSyncState(source), checkpoints: inbox.checkpointStatus(source), candidates: inbox.countCandidatesByStatus() }; }
  finally { inbox.close(); }
}

export function captureDoctor(env: NodeJS.ProcessEnv = process.env): { ok: boolean; source: "trae"; capabilities: TraeCaptureCapabilities; readiness: string } {
  const capabilities = probeTraeCapture(env);
  return { ok: capabilities.available && capabilities.appServer, source: "trae", capabilities,
    readiness: capabilities.available && capabilities.appServer ? "ready_for_sync_or_watch" : capabilities.detail || "not_ready" };
}

export async function syncTraeCapture(input: { threadId?: string; limit?: number; maxThreads?: number; lock?: boolean }, env: NodeJS.ProcessEnv = process.env): Promise<CaptureSyncResult & { inboxPath: string; threadIds: string[] }> {
  const lock = input.lock === false ? undefined : acquireCaptureLock(env);
  try {
    const config = loadConfig(env);
    if (!config?.capture.enabled || config.capture.workspaces.length === 0) {
      throw new Error("Conversation Capture is disabled or has no allowlisted workspace. Run `open-continuity capture enable <workspace>` first.");
    }
    const capabilities = probeTraeCapture(env);
    if (!capabilities.binary) throw new Error("Trae executable was not found in PATH");
    if (!capabilities.appServer) throw new Error("This Trae installation does not support app-server capture");
    const client = new TraeAppServerClient(capabilities.binary, env);
    const inboxPath = captureDatabasePath(env); const inbox = new ConversationInbox(inboxPath);
    try {
      const imported = await syncCaptureAdapter(client, inbox, {
        threadId: input.threadId, limit: input.limit, maxThreads: input.maxThreads,
        workspaces: config.capture.workspaces,
        ...(config.capture.autoCleanup ? { retentionDays: config.capture.retentionDays, pendingCandidateRetentionDays: config.capture.pendingCandidateRetentionDays } : {}),
      });
      return { ...imported, inboxPath };
    } finally { inbox.close(); }
  } finally { lock?.release(); }
}

export function listCaptureCandidates(
  input: { status?: MemoryCandidate["status"]; limit?: number },
  env: NodeJS.ProcessEnv = process.env,
  review?: { memoryDatabasePath: string; userId: string },
): { inboxPath: string; candidates: MemoryCandidate[] } {
  const inboxPath = captureDatabasePath(env); const inbox = new ConversationInbox(inboxPath);
  try {
    const candidates = review
      ? inbox.listCandidatesWithReview({ ...input, ...review })
      : inbox.listCandidates(input);
    return { inboxPath, candidates };
  } finally { inbox.close(); }
}

export function inspectCapturedThread(threadId: string, env: NodeJS.ProcessEnv = process.env, source = "trae") {
  const inboxPath = captureDatabasePath(env); const inbox = new ConversationInbox(inboxPath);
  try {
    const capture = inbox.inspectThread(threadId, source);
    if (!capture.thread) throw new Error("Captured thread not found");
    return { inboxPath, ...capture };
  } finally { inbox.close(); }
}

export async function approveCaptureCandidate(candidateId: string, config: LocalConfig, sensitivity: Sensitivity = "private", env: NodeJS.ProcessEnv = process.env, replaceMemoryId?: string) {
  const inbox = new ConversationInbox(captureDatabasePath(env));
  try { return await inbox.approveCandidate(candidateId, { memoryDatabasePath: config.databasePath, userId: config.userId, sensitivity, replaceMemoryId }); } finally { inbox.close(); }
}

export function rejectCaptureCandidate(candidateId: string, env: NodeJS.ProcessEnv = process.env) {
  const inbox = new ConversationInbox(captureDatabasePath(env));
  try { return inbox.rejectCandidate(candidateId); } finally { inbox.close(); }
}
