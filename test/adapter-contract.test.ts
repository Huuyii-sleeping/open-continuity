import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { CaptureAdapter, CaptureListResult, InjectionAdapter } from "../src/adapters/contracts.js";
import { syncCaptureAdapter } from "../src/capture/capture-adapter-service.js";
import { ConversationInbox } from "../src/capture/conversation-inbox.js";
import type { ConversationThread } from "../src/capture/types.js";
import { TraeInjectionAdapter } from "../src/injection/trae-hook-config.js";
import type { InjectionHookOutput } from "../src/injection/types.js";

class FictionalCaptureAdapter implements CaptureAdapter {
  readonly id = "fictional-agent";
  connected = false;
  closed = false;

  constructor(private readonly threads: ConversationThread[]) {}

  async connect(): Promise<void> { this.connected = true; }
  async close(): Promise<void> { this.closed = true; }
  async listThreads(): Promise<CaptureListResult> {
    return {
      threads: this.threads.map((thread) => ({ id: thread.id, cwd: thread.cwd, updatedAt: thread.updatedAt, ephemeral: thread.ephemeral })),
      pages: 1,
      truncated: false,
    };
  }
  async readThread(threadId: string): Promise<ConversationThread> {
    const thread = this.threads.find((entry) => entry.id === threadId);
    if (!thread) throw new Error("fictional thread not found");
    return thread;
  }
}

function thread(id: string, cwd: string): ConversationThread {
  return {
    source: "fictional-agent", id, sessionId: `session-${id}`, cwd, cliVersion: "1.0-fictional", ephemeral: false,
    preview: "fictional adapter contract", createdAt: "2030-01-01T00:00:00.000Z", updatedAt: "2030-01-01T00:01:00.000Z",
    turns: [{ id: `turn-${id}`, status: "completed", quality: "complete", items: [
      { id: `user-${id}`, type: "user_message", text: "请记住虚构适配器偏好是使用蓝色纸张。", rawType: "fictionalUser" },
      { id: `final-${id}`, type: "assistant_message", phase: "final_answer", text: "收到。", rawType: "fictionalAssistant" },
    ] }],
  };
}

describe("Agent Adapter contracts", () => {
  const directories: string[] = [];
  afterEach(() => { for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true }); });

  it("runs provider-neutral Capture orchestration with source isolation and workspace policy", async () => {
    const root = mkdtempSync(join(tmpdir(), "open-continuity-adapter-contract-")); directories.push(root);
    const allowed = join(root, "allowed");
    const adapter = new FictionalCaptureAdapter([thread("allowed", allowed), thread("blocked", join(root, "blocked"))]);
    const inbox = new ConversationInbox(join(root, "capture.db"));
    try {
      const result = await syncCaptureAdapter(adapter, inbox, { workspaces: [allowed], limit: 10 });
      expect(result).toMatchObject({ source: "fictional-agent", threadsSeen: 2, threadsImported: 1, skippedNotAllowed: 1, threadIds: ["allowed"] });
      expect(adapter.connected).toBe(true);
      expect(adapter.closed).toBe(true);
      expect(inbox.listCandidates()[0]).toMatchObject({ source: "fictional-agent", threadId: "allowed" });
      expect(inbox.readCheckpoint("allowed", "fictional-agent")).toMatchObject({ source: "fictional-agent" });
      expect(inbox.readSyncState("fictional-agent")).toMatchObject({ source: "fictional-agent", consecutive_failures: 0 });
      expect(inbox.inspectThread("blocked", "fictional-agent").thread).toBeNull();
    } finally { inbox.close(); }
  });

  it("implements the generic Injection contract with the Trae Adapter", () => {
    const root = mkdtempSync(join(tmpdir(), "open-continuity-injection-contract-")); directories.push(root);
    const env = { ...process.env, HOME: join(root, "home"), OPEN_CONTINUITY_HOME: join(root, "data"), TRAECLI_HOME: join(root, "trae-cli") };
    const adapter: InjectionAdapter<InjectionHookOutput> = new TraeInjectionAdapter(env, process.execPath, join(root, "fictional-hook.js"));
    expect(adapter.id).toBe("trae");
    expect(adapter.emptyOutput()).toEqual({ continue: true, suppressOutput: true });
    expect(adapter.renderContext("fictional approved memory").hookSpecificOutput?.additionalContext).toContain("fictional approved memory");
    expect(adapter.check()).toMatchObject({ valid: true, installed: false });
    expect(adapter.install()).toMatchObject({ valid: true, installed: true, changed: true });
    expect(adapter.install()).toMatchObject({ valid: true, installed: true, changed: false });
  });
});
