import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ConversationInbox } from "../src/capture/conversation-inbox.js";
import type { ConversationThread } from "../src/capture/types.js";
import { MemoryService } from "../src/core/memory-service.js";
import { SqliteMemoryStore } from "../src/sqlite/sqlite-memory-store.js";

function thread(source: string, id: string, text: string): ConversationThread {
  return {
    source,
    id,
    sessionId: `session-${id}`,
    cwd: "/tmp/fictional-candidate-workspace",
    cliVersion: "9.9.9-fictional",
    ephemeral: false,
    preview: text,
    createdAt: "2030-03-01T00:00:00.000Z",
    updatedAt: `2030-03-01T00:00:${id.length.toString().padStart(2, "0")}.000Z`,
    turns: [{
      id: `turn-${id}`,
      status: "completed",
      quality: "complete",
      items: [
        { id: `user-${id}`, type: "user_message", text, rawType: `${source}:user` },
        { id: `assistant-${id}`, type: "assistant_message", phase: "final_answer", text: "收到。", rawType: `${source}:assistant` },
      ],
    }],
  };
}

describe("Capture candidate review and evolution", () => {
  const directories: string[] = [];
  afterEach(() => { for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true }); });

  it("merges repeated evidence and requires explicit replacement for a likely conflict", async () => {
    const root = mkdtempSync(join(tmpdir(), "open-continuity-candidate-evolution-")); directories.push(root);
    const inbox = new ConversationInbox(join(root, "capture.db"));
    const memoryDatabasePath = join(root, "memories.db");
    const userId = "fictional-user";
    try {
      inbox.importThreads([thread("trae", "blue-one", "我偏好使用虚构的蓝色纸飞机。")], "trae");
      inbox.importThreads([thread("claude", "blue-two", "我偏好使用虚构的蓝色纸飞机。")], "claude");
      const pending = inbox.listCandidates();
      expect(pending).toHaveLength(1);
      expect(pending[0]).toMatchObject({ occurrenceCount: 2, value: "使用虚构的蓝色纸飞机" });

      const created = await inbox.approveCandidate(pending[0].id, { memoryDatabasePath, userId, sensitivity: "public" });
      expect(created).toMatchObject({ duplicate: false, evolution: { action: "created", version: 1 } });
      const memoryId = created.evolution.memoryId;

      // Repeated evidence after approval strengthens the same reviewed record;
      // it must not reopen a duplicate pending candidate.
      inbox.importThreads([thread("claude", "blue-three", "我偏好使用虚构的蓝色纸飞机。")], "claude");
      expect(inbox.listCandidates()).toEqual([]);
      expect(inbox.listCandidates({ status: "approved" })[0]).toMatchObject({ occurrenceCount: 3 });

      inbox.importThreads([thread("claude", "red-four", "我偏好使用虚构的红色纸飞机。")], "claude");
      const reviewCandidate = inbox.listCandidatesWithReview({ memoryDatabasePath, userId })[0];
      expect(reviewCandidate.review).toMatchObject({
        action: "replace_required",
        matches: [expect.objectContaining({ memoryId, version: 1, similarity: 0.777778 })],
      });
      await expect(inbox.approveCandidate(reviewCandidate.id, { memoryDatabasePath, userId, sensitivity: "public" }))
        .rejects.toThrow("--replace-memory");

      const replaced = await inbox.approveCandidate(reviewCandidate.id, {
        memoryDatabasePath,
        userId,
        sensitivity: "public",
        replaceMemoryId: memoryId,
      });
      expect(replaced).toMatchObject({ duplicate: false, evolution: { action: "replaced", memoryId, version: 2 } });
      const store = new SqliteMemoryStore(memoryDatabasePath);
      try {
        expect(store.inspectUserMemories({ userId, includePrivate: true })).toEqual([
          expect.objectContaining({ id: memoryId, value: "使用虚构的红色纸飞机", version: 2, supersedes: expect.objectContaining({ version: 1 }) }),
        ]);
        expect(store.inspectUserHistory({ userId, memoryId, includePrivate: true })).toHaveLength(2);
      } finally {
        store.close();
      }
    } finally {
      inbox.close();
    }
  });

  it("links an exact duplicate to an existing memory without creating another version", async () => {
    const root = mkdtempSync(join(tmpdir(), "open-continuity-candidate-duplicate-")); directories.push(root);
    const memoryDatabasePath = join(root, "memories.db");
    const userId = "fictional-user";
    const service = new MemoryService(new SqliteMemoryStore(memoryDatabasePath));
    const seeded = await service.remember({
      userId,
      agentId: "fictional-seed",
      key: "paper_plane_style",
      value: "使用虚构的蓝色纸飞机",
      kind: "user_preference",
      sensitivity: "public",
      userConfirmed: true,
      idempotencyKey: "fictional-seed-one",
    });
    await service.close();

    const inbox = new ConversationInbox(join(root, "capture.db"));
    try {
      inbox.importThreads([thread("claude", "duplicate-one", "我偏好使用虚构的蓝色纸飞机。")], "claude");
      const candidate = inbox.listCandidatesWithReview({ memoryDatabasePath, userId })[0];
      expect(candidate.review).toMatchObject({ action: "link_duplicate", matches: [expect.objectContaining({ memoryId: seeded.current.id, similarity: 1 })] });
      const approved = await inbox.approveCandidate(candidate.id, { memoryDatabasePath, userId, sensitivity: "public" });
      expect(approved).toMatchObject({ duplicate: true, memoryEventId: seeded.event.id, evolution: { action: "linked_duplicate", memoryId: seeded.current.id, version: 1 } });

      const store = new SqliteMemoryStore(memoryDatabasePath);
      try {
        expect(store.inspectUserMemories({ userId, includePrivate: true })).toHaveLength(1);
        expect(store.inspectUserHistory({ userId, includePrivate: true })).toHaveLength(1);
      } finally {
        store.close();
      }
    } finally {
      inbox.close();
    }
  });
});
