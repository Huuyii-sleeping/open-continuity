import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { CaptureAdapter, CaptureListResult } from "../src/adapters/contracts.js";
import { syncCaptureAdapter } from "../src/capture/capture-adapter-service.js";
import { ConversationInbox } from "../src/capture/conversation-inbox.js";
import type { ConversationThread } from "../src/capture/types.js";

class RestartableCaptureAdapter implements CaptureAdapter {
  readonly id = "resilience-agent";
  cycle = 0;
  failNextRead = false;

  constructor(readonly workspace: string) {}
  async connect(): Promise<void> {}
  async close(): Promise<void> {}
  async listThreads(): Promise<CaptureListResult> {
    return { threads: [{ id: "stable-thread", cwd: this.workspace, updatedAt: this.updatedAt(), ephemeral: false }], pages: 1, truncated: false };
  }
  async readThread(): Promise<ConversationThread> {
    if (this.failNextRead) { this.failNextRead = false; throw new Error("fictional transient read failure"); }
    return {
      source: this.id, id: "stable-thread", sessionId: "stable-session", cwd: this.workspace, cliVersion: "1.0-fictional", ephemeral: false,
      preview: "fictional resilience thread", createdAt: "2030-01-01T00:00:00.000Z", updatedAt: this.updatedAt(),
      turns: [{ id: "stable-turn", status: "completed", quality: "complete", items: [
        { id: "stable-user", type: "user_message", text: "请记住虚构长跑偏好是蓝色纸张。", rawType: "fictionalUser" },
        { id: "stable-final", type: "assistant_message", phase: "final_answer", text: "收到。", rawType: "fictionalAssistant" },
      ] }],
    };
  }
  updatedAt(): string { return new Date(Date.UTC(2030, 0, 1, 0, 0, this.cycle)).toISOString(); }
}

describe("Capture resilience", () => {
  const directories: string[] = [];
  afterEach(() => { for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true }); });

  it("survives an accelerated multi-cycle soak with repeated database reopen", async () => {
    const root = mkdtempSync(join(tmpdir(), "open-continuity-capture-soak-")); directories.push(root);
    const workspace = join(root, "fictional-workspace");
    const databasePath = join(root, "capture.db");
    const adapter = new RestartableCaptureAdapter(workspace);
    const cycles = Number(process.env.OPEN_CONTINUITY_SOAK_CYCLES || 100);

    for (let cycle = 1; cycle <= cycles; cycle += 1) {
      adapter.cycle = cycle;
      const inbox = new ConversationInbox(databasePath);
      try {
        const result = await syncCaptureAdapter(adapter, inbox, { workspaces: [workspace] });
        expect(result).toMatchObject({ source: adapter.id, threadsImported: 1, threadIds: ["stable-thread"] });
      } finally { inbox.close(); }
    }

    const inbox = new ConversationInbox(databasePath);
    try {
      expect(inbox.checkpointStatus(adapter.id)).toMatchObject({ threads: 1, trackedItems: 2, latestThreadUpdatedAt: adapter.updatedAt() });
      expect(inbox.countCandidatesByStatus()).toEqual({ pending: 1, approved: 0, rejected: 0 });
      expect(inbox.readSyncState(adapter.id)).toMatchObject({ source: adapter.id, consecutive_failures: 0, last_threads_imported: 1 });
    } finally { inbox.close(); }
  }, 30_000);

  it("does not advance checkpoints on a transient read failure and recovers on retry", async () => {
    const root = mkdtempSync(join(tmpdir(), "open-continuity-capture-recovery-")); directories.push(root);
    const workspace = join(root, "fictional-workspace");
    const inbox = new ConversationInbox(join(root, "capture.db"));
    const adapter = new RestartableCaptureAdapter(workspace);
    try {
      adapter.cycle = 1;
      await syncCaptureAdapter(adapter, inbox, { workspaces: [workspace] });
      const checkpointBefore = inbox.readCheckpoint("stable-thread", adapter.id);

      adapter.cycle = 2;
      adapter.failNextRead = true;
      await expect(syncCaptureAdapter(adapter, inbox, { workspaces: [workspace] })).rejects.toThrow("fictional transient read failure");
      expect(inbox.readCheckpoint("stable-thread", adapter.id)).toEqual(checkpointBefore);
      expect(inbox.readSyncState(adapter.id)).toMatchObject({ consecutive_failures: 1, last_warning: "fictional transient read failure" });

      const recovered = await syncCaptureAdapter(adapter, inbox, { workspaces: [workspace] });
      expect(recovered).toMatchObject({ threadsImported: 1, threadIds: ["stable-thread"] });
      expect(inbox.readCheckpoint("stable-thread", adapter.id)).toMatchObject({ threadUpdatedAt: adapter.updatedAt() });
      expect(inbox.readSyncState(adapter.id)).toMatchObject({ consecutive_failures: 0, last_warning: null });
    } finally { inbox.close(); }
  });
});
