import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ConversationInbox } from "../src/capture/conversation-inbox.js";
import type { ConversationThread } from "../src/capture/types.js";
import { MemoryService } from "../src/core/memory-service.js";
import { SqliteMemoryStore } from "../src/sqlite/sqlite-memory-store.js";

describe("data governance CLI", () => {
  const directories: string[] = [];
  afterEach(() => { for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true }); });

  it("reports policies and purges only transient data with explicit confirmation", async () => {
    const root = mkdtempSync(join(tmpdir(), "open-continuity-data-cli-")); directories.push(root);
    const env = { ...process.env, HOME: join(root, "home"), OPEN_CONTINUITY_HOME: join(root, "data"), PATH: process.env.PATH };
    const cli = join(process.cwd(), "dist/src/cli.js");
    execFileSync(process.execPath, [cli, "init", "--json"], { env, encoding: "utf8" });
    const config = JSON.parse(readFileSync(join(root, "data", "config.json"), "utf8"));

    const service = new MemoryService(new SqliteMemoryStore(config.databasePath));
    await service.remember({
      userId: config.userId,
      agentId: "fictional-data-test",
      key: "fictional_durable_memory",
      value: "durable fictional value",
      kind: "user_fact",
      sensitivity: "public",
      userConfirmed: true,
      idempotencyKey: "fictional-data-cli-memory",
    });
    await service.close();
    const inbox = new ConversationInbox(join(root, "data", "capture.db"));
    const thread: ConversationThread = {
      source: "claude",
      id: "fictional-transient-thread",
      sessionId: "fictional-transient-session",
      cwd: join(root, "fictional-workspace"),
      cliVersion: "9.9.9-fictional",
      ephemeral: false,
      preview: "fictional transient preview",
      createdAt: "2030-05-01T00:00:00.000Z",
      updatedAt: "2030-05-01T00:01:00.000Z",
      turns: [{ id: "fictional-turn", status: "completed", quality: "complete", items: [
        { id: "fictional-user", type: "user_message", text: "普通虚构消息。", rawType: "claude:user" },
        { id: "fictional-final", type: "assistant_message", phase: "final_answer", text: "虚构回复。", rawType: "claude:assistant" },
      ] }],
    };
    inbox.importThreads([thread], "claude");
    inbox.close();
    writeFileSync(join(root, "data", "injection-receipts.jsonl"), JSON.stringify({
      id: "fictional-receipt",
      agentId: "claude",
      memoryIds: [],
      reasons: [],
      tokenEstimate: 0,
      latencyMs: 1,
      outcome: "skipped",
      createdAt: new Date().toISOString(),
    }) + "\n");

    const status = JSON.parse(execFileSync(process.execPath, [cli, "data", "status", "--json"], { env, encoding: "utf8" }));
    expect(status).toMatchObject({
      ok: true,
      operation: "data_status",
      policies: { conversationRetentionDays: 7, pendingCandidateRetentionDays: 30, receiptRetentionDays: 30, maxReceipts: 5000 },
      inbox: { threads: 1, items: 2 },
      receipts: { count: 1 },
      longTermMemory: { preservedByTransientCleanup: true },
    });

    const refused = spawnSync(process.execPath, [cli, "data", "purge-transient", "--json"], { env, encoding: "utf8" });
    expect(refused.status).toBe(1);
    expect(JSON.parse(refused.stderr)).toMatchObject({ error: { message: expect.stringContaining("without --yes") } });

    const purged = JSON.parse(execFileSync(process.execPath, [cli, "data", "purge-transient", "--yes", "--json"], { env, encoding: "utf8" }));
    expect(purged).toMatchObject({
      ok: true,
      operation: "data_purge_transient",
      inbox: { threadsDeleted: 1, itemsDeleted: 2 },
      receipts: { deleted: 1 },
      longTermMemoryPreserved: true,
    });
    const memories = JSON.parse(execFileSync(process.execPath, [cli, "memories", "list", "--json"], { env, encoding: "utf8" }));
    expect(memories.memories).toEqual([expect.objectContaining({ key: "fictional_durable_memory", value: "durable fictional value" })]);
  }, 15_000);
});
