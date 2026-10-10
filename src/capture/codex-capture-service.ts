import { isWorkspaceAllowed, loadConfig } from "../cli/config.js";
import { syncCaptureAdapter } from "./capture-adapter-service.js";
import { ConversationInbox } from "./conversation-inbox.js";
import { captureDatabasePath } from "./paths.js";
import { CodexAppServerCaptureAdapter, probeCodexCapture } from "./codex-app-server.js";
import { findExecutable } from "../cli/connectors.js";
import type { CaptureSyncResult } from "./types.js";

export type CodexCaptureHookResult =
  | { outcome: "disabled"; detail: string }
  | { outcome: "captured"; source: "codex"; threadId: string; turnsImported: number; itemsImported: number; candidatesCreated: number };

function parseCodexStopInput(input: unknown): { session_id: string; cwd: string; hook_event_name?: string } {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error("Invalid Codex Stop hook input");
  const value = input as Record<string, unknown>;
  for (const field of ["session_id", "cwd"] as const) {
    if (typeof value[field] !== "string" || !value[field]) throw new Error(`Codex Stop hook is missing ${field}`);
  }
  if (value.hook_event_name != null && value.hook_event_name !== "Stop") throw new Error("Codex Capture only accepts Stop hook input");
  return value as { session_id: string; cwd: string; hook_event_name?: string };
}

export async function runCodexCaptureHook(
  rawInput: unknown,
  env: NodeJS.ProcessEnv = process.env,
): Promise<CodexCaptureHookResult> {
  const input = parseCodexStopInput(rawInput);
  const config = loadConfig(env);
  if (!config?.capture.enabled || config.capture.workspaces.length === 0) {
    return { outcome: "disabled", detail: "capture_disabled_or_no_allowlisted_workspace" };
  }
  if (!isWorkspaceAllowed(config.capture.workspaces, input.cwd)) {
    return { outcome: "disabled", detail: "workspace_not_allowed" };
  }
  const capabilities = probeCodexCapture(env);
  const binary = capabilities.binary || findExecutable(["codex"], env);
  if (!binary || !capabilities.appServer) return { outcome: "disabled", detail: "codex_app_server_unavailable" };

  const inbox = new ConversationInbox(captureDatabasePath(env));
  try {
    const adapter = new CodexAppServerCaptureAdapter(binary, env);
    const result = await syncCaptureAdapter(adapter, inbox, {
      threadId: input.session_id,
      workspaces: config.capture.workspaces,
      ...(config.capture.autoCleanup ? { retentionDays: config.capture.retentionDays, pendingCandidateRetentionDays: config.capture.pendingCandidateRetentionDays } : {}),
    });
    return {
      outcome: "captured", source: "codex", threadId: input.session_id,
      turnsImported: result.turnsImported, itemsImported: result.itemsImported, candidatesCreated: result.candidatesCreated,
    };
  } finally {
    inbox.close();
  }
}

export function captureCodexStatus(env: NodeJS.ProcessEnv = process.env) {
  const inbox = new ConversationInbox(captureDatabasePath(env));
  try {
    return {
      source: "codex", inboxPath: captureDatabasePath(env), sync: inbox.readSyncState("codex"),
      checkpoints: inbox.checkpointStatus("codex"), candidates: inbox.countCandidatesByStatus(),
    };
  } finally { inbox.close(); }
}

export function codexCaptureDoctor(env: NodeJS.ProcessEnv = process.env) {
  const capabilities = probeCodexCapture(env);
  return {
    ok: capabilities.available && capabilities.appServer,
    source: "codex" as const,
    capabilities,
    readiness: capabilities.available && capabilities.appServer ? "ready_for_hook_or_sync" : capabilities.detail || "not_ready",
  };
}

export async function syncCodexCapture(
  input: { threadId?: string; limit?: number; maxThreads?: number; lock?: boolean },
  env: NodeJS.ProcessEnv = process.env,
): Promise<CaptureSyncResult & { inboxPath: string; threadIds: string[] }> {
  const config = loadConfig(env);
  if (!config?.capture.enabled || config.capture.workspaces.length === 0) {
    throw new Error("Conversation Capture is disabled or has no allowlisted workspace. Run `open-continuity capture enable <workspace>` first.");
  }
  const capabilities = probeCodexCapture(env);
  if (!capabilities.binary) throw new Error("Codex executable was not found in PATH");
  if (!capabilities.appServer) throw new Error("This Codex installation does not support app-server capture");
  const inboxPath = captureDatabasePath(env);
  const inbox = new ConversationInbox(inboxPath);
  try {
    const adapter = new CodexAppServerCaptureAdapter(capabilities.binary, env);
    const imported = await syncCaptureAdapter(adapter, inbox, {
      threadId: input.threadId, limit: input.limit, maxThreads: input.maxThreads,
      workspaces: config.capture.workspaces,
      ...(config.capture.autoCleanup ? { retentionDays: config.capture.retentionDays, pendingCandidateRetentionDays: config.capture.pendingCandidateRetentionDays } : {}),
    });
    return { ...imported, inboxPath };
  } finally { inbox.close(); }
}
