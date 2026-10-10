import { mkdtempSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import type { CaptureAdapter } from "../src/adapters/contracts.js";
import { syncCaptureAdapter } from "../src/capture/capture-adapter-service.js";
import { ConversationInbox } from "../src/capture/conversation-inbox.js";
import type { ConversationThread } from "../src/capture/types.js";
import { cleanupInjectionReceipts, injectionReceiptPath, injectionReceiptStatus, purgeInjectionReceipts } from "../src/injection/receipt-store.js";
import { SqliteMemoryStore } from "../src/sqlite/sqlite-memory-store.js";

function fictionalThread(): ConversationThread {
  return {
    source: "claude",
    id: "fictional-governance-thread",
    sessionId: "fictional-governance-session",
    cwd: "/tmp/fictional-governance-workspace",
    cliVersion: "9.9.9-fictional",
    ephemeral: false,
    preview: "fictional governance thread",
    createdAt: "2030-04-01T00:00:00.000Z",
    updatedAt: "2030-04-01T00:01:00.000Z",
    turns: [{
      id: "fictional-governance-turn",
      status: "completed",
      quality: "complete",
      items: [
        { id: "fictional-governance-user", type: "user_message", text: "请记住虚构治理偏好是保留蓝色纸飞机。", rawType: "claude:user" },
        { id: "fictional-governance-final", type: "assistant_message", phase: "final_answer", text: "收到。", rawType: "claude:assistant" },
      ],
    }],
  };
}

describe("local data governance", () => {
  const directories: string[] = [];
  afterEach(() => { for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true }); });

  it("bounds Receipt history by age and count without retaining malformed lines", () => {
    const root = mkdtempSync(join(tmpdir(), "open-continuity-receipt-governance-")); directories.push(root);
    const env = { ...process.env, HOME: join(root, "home"), OPEN_CONTINUITY_HOME: join(root, "data") };
    const path = injectionReceiptPath(env);
    mkdirSync(join(root, "data"), { recursive: true });
    const receipt = (id: string, createdAt: string) => JSON.stringify({ id, agentId: "fictional", memoryIds: [], reasons: [], tokenEstimate: 0, latencyMs: 1, outcome: "skipped", createdAt });
    writeFileSync(path, [
      receipt("old", "2029-01-01T00:00:00.000Z"),
      receipt("recent-one", "2030-03-20T00:00:00.000Z"),
      "malformed fictional receipt",
      receipt("recent-two", "2030-03-25T00:00:00.000Z"),
      receipt("recent-three", "2030-03-30T00:00:00.000Z"),
    ].join("\n") + "\n");

    const result = cleanupInjectionReceipts(env, { receiptRetentionDays: 30, maxReceipts: 2 }, Date.parse("2030-04-01T00:00:00.000Z"));
    expect(result).toMatchObject({ before: 5, retained: 2, deleted: 3, invalidDeleted: 1 });
    const contents = readFileSync(path, "utf8");
    expect(contents).not.toContain("old");
    expect(contents).not.toContain("malformed");
    expect(contents).not.toContain("recent-one");
    expect(contents).toContain("recent-two");
    expect(contents).toContain("recent-three");
    expect(injectionReceiptStatus(env)).toMatchObject({ exists: true, count: 2 });
    expect(statSync(path).mode & 0o777).toBe(0o600);
    expect(purgeInjectionReceipts(env)).toMatchObject({ deleted: 2 });
    expect(injectionReceiptStatus(env)).toMatchObject({ exists: false, count: 0 });
  });

  it("migrates a pre-review Capture database without losing pending candidates", () => {
    const root = mkdtempSync(join(tmpdir(), "open-continuity-capture-migration-")); directories.push(root);
    const capturePath = join(root, "capture.db");
    const legacy = new DatabaseSync(capturePath);
    legacy.exec("CREATE TABLE memory_candidates (id TEXT PRIMARY KEY, source TEXT NOT NULL, thread_id TEXT NOT NULL, turn_id TEXT NOT NULL, item_id TEXT NOT NULL, kind TEXT NOT NULL, memory_key TEXT NOT NULL, value TEXT NOT NULL, evidence TEXT NOT NULL, rationale TEXT NOT NULL, confidence REAL NOT NULL, sensitivity TEXT NOT NULL, capture_quality TEXT NOT NULL, status TEXT NOT NULL, created_at TEXT NOT NULL, reviewed_at TEXT, memory_event_id TEXT, UNIQUE (source, thread_id, turn_id, item_id, memory_key))");
    legacy.prepare("INSERT INTO memory_candidates (id, source, thread_id, turn_id, item_id, kind, memory_key, value, evidence, rationale, confidence, sensitivity, capture_quality, status, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)")
      .run("legacy-candidate", "trae", "legacy-thread", "legacy-turn", "legacy-item", "user_fact", "legacy:key", "fictional legacy value", "fictional legacy evidence", "explicit_remember_request", 0.98, "private", "complete", "pending", "2030-01-01T00:00:00.000Z");
    legacy.close();

    const migrated = new ConversationInbox(capturePath);
    try {
      expect(migrated.listCandidates()).toEqual([
        expect.objectContaining({ id: "legacy-candidate", dedupeKey: "legacy:key", occurrenceCount: 1, lastSeenAt: "2030-01-01T00:00:00.000Z" }),
      ]);
      expect(migrated.governanceStatus()).toMatchObject({ candidates: { pending: 1 }, occurrences: 1 });
    } finally {
      migrated.close();
    }
  });

  it("purges transient Inbox data while preserving approved long-term memory", async () => {
    const root = mkdtempSync(join(tmpdir(), "open-continuity-inbox-governance-")); directories.push(root);
    const capturePath = join(root, "capture.db");
    const memoryPath = join(root, "memories.db");
    const inbox = new ConversationInbox(capturePath);
    try {
      inbox.importThreads([fictionalThread()], "claude");
      const candidate = inbox.listCandidates()[0];
      await inbox.approveCandidate(candidate.id, { memoryDatabasePath: memoryPath, userId: "fictional-user", sensitivity: "public" });
      expect(inbox.governanceStatus()).toMatchObject({ threads: 1, turns: 1, items: 2, candidates: { approved: 1 }, occurrences: 1 });

      expect(inbox.purgeInbox()).toMatchObject({ threadsDeleted: 1, turnsDeleted: 1, itemsDeleted: 2, candidatesDeleted: 1, occurrencesDeleted: 1, checkpointsDeleted: 1 });
      expect(inbox.governanceStatus()).toEqual({ threads: 0, turns: 0, items: 0, candidates: { pending: 0, approved: 0, rejected: 0 }, occurrences: 0 });

      const store = new SqliteMemoryStore(memoryPath);
      try {
        expect(store.inspectUserMemories({ userId: "fictional-user", includePrivate: true })).toEqual([
          expect.objectContaining({ value: "虚构治理偏好是保留蓝色纸飞机", version: 1 }),
        ]);
      } finally {
        store.close();
      }
      expect(statSync(capturePath).mode & 0o777).toBe(0o600);
      expect(statSync(memoryPath).mode & 0o777).toBe(0o600);
    } finally {
      inbox.close();
    }
  });

  it("expires old turns inside an active conversation and does not reimport them", async () => {
    const root = mkdtempSync(join(tmpdir(), "open-continuity-turn-retention-")); directories.push(root);
    const inbox = new ConversationInbox(join(root, "capture.db"));
    const now = Date.parse("2030-04-10T00:00:00.000Z");
    const activeThread: ConversationThread = {
      source: "claude",
      id: "fictional-long-session",
      sessionId: "fictional-long-session",
      cwd: root,
      cliVersion: "9.9.9-fictional",
      ephemeral: false,
      preview: "old fictional prompt that must expire",
      createdAt: "2030-03-01T00:00:00.000Z",
      updatedAt: "2030-04-10T00:00:00.000Z",
      turns: [
        { id: "old-turn", status: "completed", quality: "complete", startedAt: "2030-03-01T00:00:00.000Z", completedAt: "2030-03-01T00:01:00.000Z", items: [
          { id: "old-user", type: "user_message", text: "old fictional prompt that must expire", rawType: "claude:user" },
          { id: "old-final", type: "assistant_message", phase: "final_answer", text: "old fictional answer", rawType: "claude:assistant" },
        ] },
        { id: "recent-turn", status: "completed", quality: "complete", startedAt: "2030-04-09T00:00:00.000Z", completedAt: "2030-04-09T00:01:00.000Z", items: [
          { id: "recent-user", type: "user_message", text: "recent fictional prompt", rawType: "claude:user" },
          { id: "recent-final", type: "assistant_message", phase: "final_answer", text: "recent fictional answer", rawType: "claude:assistant" },
        ] },
      ],
    };
    const adapter: CaptureAdapter = {
      id: "claude",
      async connect() {},
      async listThreads() { return { threads: [], pages: 1, truncated: false }; },
      async readThread() { return activeThread; },
      async close() {},
    };
    try {
      inbox.importThreads([activeThread], "claude");
      expect(inbox.cleanupExpired(7, now, 30)).toMatchObject({ threadsDeleted: 0, turnsDeleted: 1, itemsDeleted: 2 });
      expect(inbox.inspectThread(activeThread.id, "claude").items.map((item) => item.id)).toEqual(["recent-user", "recent-final"]);

      await syncCaptureAdapter(adapter, inbox, { threadId: activeThread.id, workspaces: [root], retentionDays: 7, pendingCandidateRetentionDays: 30, now });
      const retained = inbox.inspectThread(activeThread.id, "claude");
      expect(retained.items.map((item) => item.id)).toEqual(["recent-user", "recent-final"]);
      expect(retained.thread?.preview).toBe("recent fictional prompt");
    } finally {
      inbox.close();
    }
  });
});
