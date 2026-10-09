import type { LocalConfig } from "../cli/config.js";
import { continuityHome, loadConfig } from "../cli/config.js";
import { ConversationInbox } from "./conversation-inbox.js";
import { probeTraeCapture, TraeAppServerClient, type TraeCaptureCapabilities } from "./trae-app-server.js";
import type { CaptureSyncResult, MemoryCandidate } from "./types.js";
import type { Sensitivity } from "../shared/types.js";
import { acquireCaptureLock } from "./capture-lock.js";

export function captureDatabasePath(env: NodeJS.ProcessEnv = process.env): string { return continuityHome(env) + "/capture.db"; }

export function captureStatus(env: NodeJS.ProcessEnv = process.env) {
  const inbox = new ConversationInbox(captureDatabasePath(env));
  try { return { inboxPath: captureDatabasePath(env), sync: inbox.readSyncState(), checkpoints: inbox.checkpointStatus(), candidates: inbox.countCandidatesByStatus() }; }
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
    const capabilities = probeTraeCapture(env);
    if (!capabilities.binary) throw new Error("Trae executable was not found in PATH");
    if (!capabilities.appServer) throw new Error("This Trae installation does not support app-server capture");
    const client = new TraeAppServerClient(capabilities.binary, env);
    const inboxPath = captureDatabasePath(env); const inbox = new ConversationInbox(inboxPath);
    try {
      await client.connect();
    const listed = input.threadId ? null : await client.listThreads({ pageSize: input.limit ?? 10, maxThreads: input.maxThreads ?? 100 });
    const listedThreads = listed?.threads ?? null;
    const threadIds = input.threadId ? [input.threadId] : listedThreads!.filter((thread) => !thread.ephemeral && inbox.threadNeedsSync(thread.id, new Date(thread.updatedAt < 10_000_000_000 ? thread.updatedAt * 1000 : thread.updatedAt).toISOString())).map((thread) => thread.id);
    const skippedUnchanged = listedThreads ? listedThreads.filter((thread) => !thread.ephemeral && !threadIds.includes(thread.id)).length : 0;
    const threads = [];
    for (const threadId of threadIds) threads.push(await client.readThread(threadId));
    const imported = inbox.importThreads(threads);
    if (listedThreads) {
      imported.threadsSeen = listedThreads.length;
      imported.skippedEphemeral += listedThreads.filter((thread) => thread.ephemeral).length;
      imported.skippedUnchanged = skippedUnchanged;
      if (listed?.truncated) imported.warning = "Thread scan reached maxThreads before exhausting app-server pages";
      imported.pagesScanned = listed?.pages ?? 0;
    }
    const config = loadConfig(env);
    if (config?.capture.autoCleanup) Object.assign(imported, { cleanup: inbox.cleanupExpired(config.capture.retentionDays) });
    inbox.recordSyncSuccess(imported);
      return { ...imported, inboxPath, threadIds };
    } catch (error) {
      inbox.recordSyncFailure(error);
      throw error;
    } finally { await client.close(); inbox.close(); }
  } finally { lock?.release(); }
}

export function listCaptureCandidates(input: { status?: MemoryCandidate["status"]; limit?: number }, env: NodeJS.ProcessEnv = process.env): { inboxPath: string; candidates: MemoryCandidate[] } {
  const inboxPath = captureDatabasePath(env); const inbox = new ConversationInbox(inboxPath);
  try { return { inboxPath, candidates: inbox.listCandidates(input) }; } finally { inbox.close(); }
}

export function inspectCapturedThread(threadId: string, env: NodeJS.ProcessEnv = process.env) {
  const inboxPath = captureDatabasePath(env); const inbox = new ConversationInbox(inboxPath);
  try {
    const capture = inbox.inspectThread(threadId);
    if (!capture.thread) throw new Error("Captured thread not found");
    return { inboxPath, ...capture };
  } finally { inbox.close(); }
}

export async function approveCaptureCandidate(candidateId: string, config: LocalConfig, sensitivity: Sensitivity = "private", env: NodeJS.ProcessEnv = process.env) {
  const inbox = new ConversationInbox(captureDatabasePath(env));
  try { return await inbox.approveCandidate(candidateId, { memoryDatabasePath: config.databasePath, userId: config.userId, sensitivity }); } finally { inbox.close(); }
}

export function rejectCaptureCandidate(candidateId: string, env: NodeJS.ProcessEnv = process.env) {
  const inbox = new ConversationInbox(captureDatabasePath(env));
  try { return inbox.rejectCandidate(candidateId); } finally { inbox.close(); }
}
