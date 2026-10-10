import { isWorkspaceAllowed, loadConfig } from "../cli/config.js";
import { syncCaptureAdapter } from "./capture-adapter-service.js";
import { ConversationInbox } from "./conversation-inbox.js";
import { captureDatabasePath } from "./paths.js";
import { ClaudeTranscriptCaptureAdapter, type ClaudeStopHookInput } from "./claude-transcript.js";

export type ClaudeCaptureHookResult =
  | { outcome: "disabled"; detail: string }
  | { outcome: "captured"; source: "claude"; threadId: string; turnsImported: number; itemsImported: number; candidatesCreated: number };

function parseClaudeStopInput(input: unknown): ClaudeStopHookInput {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error("Invalid Claude Stop hook input");
  const value = input as Record<string, unknown>;
  for (const field of ["session_id", "transcript_path", "cwd"] as const) {
    if (typeof value[field] !== "string" || !value[field]) throw new Error(`Claude Stop hook is missing ${field}`);
  }
  if (value.hook_event_name != null && value.hook_event_name !== "Stop") throw new Error("Claude Capture only accepts Stop hook input");
  if (value.last_assistant_message != null && typeof value.last_assistant_message !== "string") throw new Error("Invalid Claude last_assistant_message");
  return value as ClaudeStopHookInput;
}

export async function runClaudeCaptureHook(
  rawInput: unknown,
  env: NodeJS.ProcessEnv = process.env,
  observedAt = new Date().toISOString(),
): Promise<ClaudeCaptureHookResult> {
  const input = parseClaudeStopInput(rawInput);
  const config = loadConfig(env);
  if (!config?.capture.enabled || config.capture.workspaces.length === 0) {
    return { outcome: "disabled", detail: "capture_disabled_or_no_allowlisted_workspace" };
  }
  if (!isWorkspaceAllowed(config.capture.workspaces, input.cwd)) {
    return { outcome: "disabled", detail: "workspace_not_allowed" };
  }

  const inbox = new ConversationInbox(captureDatabasePath(env));
  try {
    const adapter = new ClaudeTranscriptCaptureAdapter(input, observedAt, config.capture.workspaces);
    const result = await syncCaptureAdapter(adapter, inbox, {
      threadId: input.session_id,
      workspaces: config.capture.workspaces,
      ...(config.capture.autoCleanup ? { retentionDays: config.capture.retentionDays, pendingCandidateRetentionDays: config.capture.pendingCandidateRetentionDays } : {}),
    });
    return {
      outcome: "captured",
      source: "claude",
      threadId: input.session_id,
      turnsImported: result.turnsImported,
      itemsImported: result.itemsImported,
      candidatesCreated: result.candidatesCreated,
    };
  } finally {
    inbox.close();
  }
}
