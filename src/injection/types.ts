export interface InjectionHookInput {
  prompt?: string;
  cwd?: string;
  session_id?: string;
  turn_id?: string;
  hook_event_name?: string;
  [key: string]: unknown;
}

export type InjectionOutcome = "injected" | "skipped" | "disabled" | "timeout" | "failed";

export interface InjectionReceipt {
  id: string;
  agentId: string;
  workspacePath?: string;
  sessionId?: string;
  turnId?: string;
  promptFingerprint?: string;
  memoryIds: string[];
  reasons: string[];
  tokenEstimate: number;
  latencyMs: number;
  outcome: InjectionOutcome;
  createdAt: string;
  detail?: string;
}

export interface InjectionHookOutput {
  continue: true;
  suppressOutput: true;
  hookSpecificOutput?: { hookEventName: "UserPromptSubmit"; additionalContext: string };
}
