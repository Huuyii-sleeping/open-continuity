import { isWorkspaceAllowed } from "../cli/config.js";
import type { CaptureAdapter } from "../adapters/contracts.js";
import { ConversationInbox } from "./conversation-inbox.js";
import type { CaptureSyncResult, ConversationThread } from "./types.js";

export interface CaptureAdapterSyncInput {
  threadId?: string;
  limit?: number;
  maxThreads?: number;
  workspaces: string[];
  retentionDays?: number;
  pendingCandidateRetentionDays?: number;
  now?: number;
}

function retainedPreview(thread: ConversationThread): string {
  return thread.turns.flatMap((turn) => turn.items)
    .find((item) => item.type === "user_message" && item.text)?.text?.slice(0, 240)
    ?? "Conversation metadata retained after raw-content expiry";
}

export function applyConversationRetention(thread: ConversationThread, retentionDays: number, now = Date.now()): ConversationThread {
  const cutoff = now - retentionDays * 24 * 60 * 60 * 1000;
  const turns = thread.turns.filter((turn) => {
    const observedAt = turn.completedAt ?? turn.startedAt;
    if (!observedAt) return true;
    const timestamp = Date.parse(observedAt);
    return !Number.isFinite(timestamp) || timestamp >= cutoff;
  });
  if (turns.length === thread.turns.length) return thread;
  const retained = { ...thread, turns };
  return { ...retained, preview: retainedPreview(retained) };
}

export async function syncCaptureAdapter(
  adapter: CaptureAdapter,
  inbox: ConversationInbox,
  input: CaptureAdapterSyncInput,
): Promise<CaptureSyncResult & { threadIds: string[] }> {
  await adapter.connect();
  try {
    const listed = input.threadId ? null : await adapter.listThreads({ pageSize: input.limit ?? 10, maxThreads: input.maxThreads ?? 100 });
    const listedThreads = listed?.threads ?? null;
    const allowedListedThreads = listedThreads?.filter((thread) => !thread.ephemeral && isWorkspaceAllowed(input.workspaces, thread.cwd)) ?? null;
    const threadIds = input.threadId ? [input.threadId] : allowedListedThreads!
      .filter((thread) => inbox.threadNeedsSync(adapter.id, thread.id, thread.updatedAt))
      .map((thread) => thread.id);
    const skippedUnchanged = allowedListedThreads ? allowedListedThreads.filter((thread) => !threadIds.includes(thread.id)).length : 0;
    const skippedNotAllowed = listedThreads ? listedThreads.filter((thread) => !thread.ephemeral && !isWorkspaceAllowed(input.workspaces, thread.cwd)).length : 0;
    const threads = [];
    for (const threadId of threadIds) {
      const thread = await adapter.readThread(threadId);
      if (thread.source !== adapter.id) throw new Error(`Capture Adapter ${adapter.id} returned mismatched source ${thread.source}`);
      if (!isWorkspaceAllowed(input.workspaces, thread.cwd)) {
        if (input.threadId) throw new Error(`Thread workspace is not allowlisted for Capture: ${thread.cwd}`);
        continue;
      }
      threads.push(input.retentionDays == null ? thread : applyConversationRetention(thread, input.retentionDays, input.now));
    }
    const imported = inbox.importThreads(threads, adapter.id);
    if (listedThreads) {
      imported.threadsSeen = listedThreads.length;
      imported.skippedEphemeral += listedThreads.filter((thread) => thread.ephemeral).length;
      imported.skippedNotAllowed = skippedNotAllowed;
      imported.skippedUnchanged = skippedUnchanged;
      if (listed?.truncated) imported.warning = "Thread scan reached maxThreads before exhausting Adapter pages";
      imported.pagesScanned = listed?.pages ?? 0;
    }
    if (input.retentionDays != null) Object.assign(imported, { cleanup: inbox.cleanupExpired(input.retentionDays, input.now ?? Date.now(), input.pendingCandidateRetentionDays) });
    inbox.recordSyncSuccess(imported);
    return { ...imported, threadIds };
  } catch (error) {
    inbox.recordSyncFailure(adapter.id, error);
    throw error;
  } finally {
    await adapter.close();
  }
}
