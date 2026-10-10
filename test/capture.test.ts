import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { extractMemoryCandidates } from "../src/capture/candidate-extractor.js";
import { ConversationInbox } from "../src/capture/conversation-inbox.js";
import { captureDoctor, captureStatus, listCaptureCandidates, syncTraeCapture } from "../src/capture/trae-capture-service.js";
import { acquireCaptureLock, captureLockPath } from "../src/capture/capture-lock.js";
import {
  CAPTURE_SERVICE_LABEL,
  captureServiceSupported,
  captureServicePaths,
  installCaptureService,
  renderCaptureServicePlist,
  startCaptureService,
  statusCaptureService,
  stopCaptureService,
  uninstallCaptureService,
  type CaptureServiceRuntime,
} from "../src/capture/capture-service.js";
import { redactSensitiveText } from "../src/capture/sensitivity.js";
import type { ConversationItem, ConversationThread } from "../src/capture/types.js";
import { defaultConfig, saveConfig } from "../src/cli/config.js";
import { SqliteMemoryStore } from "../src/sqlite/sqlite-memory-store.js";
import { FAKE_TRAE_THREAD_ID, installFakeTraeCli } from "./helpers/fake-trae.js";

describe("Trae conversation capture", () => {
  const directories: string[] = [];
  afterEach(() => { for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true }); });

  function enableCapture(env: NodeJS.ProcessEnv, workspace: string): void {
    const config = defaultConfig(env);
    config.capture = { ...config.capture, enabled: true, workspaces: [workspace] };
    saveConfig(config, env);
  }

  it("extracts only explicit memory signals and lowers confidence for incomplete turns", () => {
    const item: ConversationItem = { id: "item-1", type: "user_message", text: "我偏好先给结论，再列出验证结果。", rawType: "userMessage" };
    const complete = extractMemoryCandidates({ source: "trae", threadId: "thread-1", turnId: "turn-1", quality: "complete", item, now: "2030-01-01T00:00:00.000Z" });
    expect(complete).toHaveLength(1);
    expect(complete[0]).toMatchObject({ kind: "user_preference", value: "先给结论，再列出验证结果", rationale: "stated_preference", confidence: 0.92, sensitivity: "private", captureQuality: "complete", status: "pending" });

    const partial = extractMemoryCandidates({ source: "trae", threadId: "thread-1", turnId: "turn-2", quality: "partial", item });
    expect(partial[0]?.confidence).toBe(0.6);
    expect(extractMemoryCandidates({ source: "trae", threadId: "thread-1", turnId: "turn-decision", quality: "complete", item: { ...item, text: "我们决定以后先运行类型检查，再运行完整测试。" } })).toMatchObject([
      expect.objectContaining({ kind: "decision", value: "先运行类型检查，再运行完整测试" }),
    ]);
    expect(extractMemoryCandidates({ source: "trae", threadId: "thread-1", turnId: "turn-3", quality: "complete", item: { ...item, text: "请解释这个虚构模块。" } })).toEqual([]);
  });

  it("imports idempotently and writes only approved candidates to long-term memory", async () => {
    const root = mkdtempSync(join(tmpdir(), "open-continuity-capture-inbox-")); directories.push(root);
    const inbox = new ConversationInbox(join(root, "capture.db"));
    const thread: ConversationThread = {
      source: "trae", id: "thread-1", sessionId: "session-1", cwd: "/tmp/fictional-workspace", cliVersion: "9.9.9-fictional",
      preview: "Fictional capture", ephemeral: false, createdAt: "2030-01-01T00:00:00.000Z", updatedAt: "2030-01-01T00:01:00.000Z",
      turns: [
        { id: "turn-1", status: "completed", quality: "complete", items: [
          { id: "item-1", type: "user_message", text: "请记住代号是蓝色纸飞机。", rawType: "userMessage" },
          { id: "item-2", type: "assistant_message", phase: "final_answer", text: "收到。", rawType: "agentMessage" },
        ] },
        { id: "turn-2", status: "interrupted", quality: "interrupted", items: [
          { id: "item-3", type: "user_message", text: "以后请使用虚构示例。", rawType: "userMessage" },
        ] },
      ],
    };

    expect(inbox.importThreads([thread])).toMatchObject({ threadsSeen: 1, threadsImported: 1, turnsImported: 2, itemsImported: 3, candidatesCreated: 2 });
    expect(inbox.readCheckpoint(thread.id)).toMatchObject({
      source: "trae", threadId: thread.id, threadUpdatedAt: thread.updatedAt, lastTurnId: "turn-2", lastItemId: "item-3", lastItemCount: 3,
    });
    expect(inbox.importThreads([thread])).toMatchObject({ threadsSeen: 1, threadsImported: 0, turnsImported: 0, itemsImported: 0, candidatesCreated: 0 });
    const interruptedTurn = thread.turns[1]!;
    interruptedTurn.status = "completed"; interruptedTurn.quality = "complete";
    interruptedTurn.items.push({ id: "item-4", type: "assistant_message", phase: "final_answer", text: "收到。", rawType: "agentMessage" });
    thread.updatedAt = "2030-01-01T00:02:00.000Z";
    expect(inbox.importThreads([thread])).toMatchObject({ threadsImported: 1, turnsImported: 0, itemsImported: 1, candidatesCreated: 0 });
    expect(inbox.readCheckpoint(thread.id)).toMatchObject({ threadUpdatedAt: thread.updatedAt, lastTurnId: "turn-2", lastItemId: "item-4", lastItemCount: 4 });
    const candidates = inbox.listCandidates();
    expect(candidates).toHaveLength(2);
    expect(candidates.find((candidate) => candidate.turnId === "turn-2")).toMatchObject({ captureQuality: "complete", confidence: 0.9 });

    const memoryDatabasePath = join(root, "memories.db");
    const approved = await inbox.approveCandidate(candidates[0]!.id, { memoryDatabasePath, userId: "user-fictional", sensitivity: "public" });
    expect(approved.duplicate).toBe(false);
    expect(approved.candidate.sensitivity).toBe("public");
    expect((await inbox.approveCandidate(candidates[0]!.id, { memoryDatabasePath, userId: "user-fictional", sensitivity: "public" })).duplicate).toBe(true);
    await expect(inbox.approveCandidate(candidates[0]!.id, { memoryDatabasePath, userId: "user-fictional", sensitivity: "private" })).rejects.toThrow("already approved");
    const rejected = inbox.rejectCandidate(candidates[1]!.id);
    expect(rejected.status).toBe("rejected");
    const privateThread: ConversationThread = { ...thread, id: "thread-private", sessionId: "session-private", updatedAt: "2030-01-01T00:03:00.000Z", turns: [
      { id: "turn-private", status: "completed", quality: "complete", items: [
        { id: "item-private-user", type: "user_message", text: "请记住内部代号是虚构的绿纸船。", rawType: "userMessage" },
        { id: "item-private-final", type: "assistant_message", phase: "final_answer", text: "收到。", rawType: "agentMessage" },
      ] },
    ] };
    inbox.importThreads([privateThread]);
    const privateCandidate = inbox.listCandidates().find((candidate) => candidate.threadId === privateThread.id)!;
    const privateApproval = await inbox.approveCandidate(privateCandidate.id, { memoryDatabasePath, userId: "user-fictional" });
    expect(privateApproval.candidate.sensitivity).toBe("private");

    const store = new SqliteMemoryStore(memoryDatabasePath);
    expect(store.inspectUserMemories({ userId: "user-fictional", includePrivate: false, limit: 10 })).toHaveLength(1);
    expect(store.inspectUserMemories({ userId: "user-fictional", includePrivate: true, limit: 10 })).toHaveLength(2);
    store.close();
    inbox.close();
  });

  it("redacts sensitive values before storing the conversation and blocks memory candidates", () => {
    expect(redactSensitiveText("联系 fictional.person@example.test，token=fictional-secret-value-123456").text)
      .toBe("联系 <redacted:email>，<redacted:credential>");

    const root = mkdtempSync(join(tmpdir(), "open-continuity-capture-sensitive-")); directories.push(root);
    const inbox = new ConversationInbox(join(root, "capture.db"));
    const thread: ConversationThread = {
      source: "trae", id: "thread-sensitive", sessionId: "session-sensitive", cwd: "/tmp/fictional-workspace", cliVersion: "9.9.9-fictional",
      preview: "Fictional sensitive capture token=fictional-preview-secret-123456", ephemeral: false, createdAt: "2030-01-01T00:00:00.000Z", updatedAt: "2030-01-01T00:01:00.000Z",
      turns: [{ id: "turn-sensitive", status: "completed", quality: "complete", items: [
        { id: "item-sensitive-user", type: "user_message", text: "请记住邮箱是 fictional.person@example.test", rawType: "userMessage" },
        { id: "item-sensitive-tool", type: "tool_call", toolName: "fictional-tool", toolInput: { apiKey: "fictional-api-key" }, toolOutput: "token=fictional-secret-value-123456", rawType: "toolCall" },
        { id: "item-safe", type: "assistant_message", phase: "final_answer", text: "收到虚构请求。", rawType: "agentMessage" },
      ] }],
    };
    const result = inbox.importThreads([thread]);
    expect(result).toMatchObject({ itemsImported: 3, candidatesCreated: 0, sensitiveItemsRedacted: 2, candidatesBlockedSensitive: 1 });
    const captured = inbox.inspectThread(thread.id);
    expect(captured.thread?.preview).toBe("Fictional sensitive capture <redacted:credential>");
    expect(captured.items[0]).toMatchObject({ sensitive: true, redacted: true });
    expect(JSON.stringify(captured.thread)).not.toContain("fictional-preview-secret-123456");
    expect(JSON.stringify(captured.items)).not.toContain("fictional.person@example.test");
    expect(JSON.stringify(captured.items)).not.toContain("fictional-secret-value-123456");
    expect(JSON.stringify(captured.items)).not.toContain("fictional-api-key");
    expect(inbox.listCandidates()).toEqual([]);
    inbox.close();
  });

  it("does not classify real-shaped Trae protocol identifiers as conversation secrets", () => {
    const root = mkdtempSync(join(tmpdir(), "open-continuity-capture-real-id-")); directories.push(root);
    const inbox = new ConversationInbox(join(root, "capture.db"));
    const thread: ConversationThread = {
      source: "trae", id: "01a11ec6-7e21-7af3-abf5-d005540b976b", sessionId: "01a11ec6-7e21-7af3-abf5-d005540b976b",
      cwd: "/tmp/fictional-workspace", cliVersion: "9.9.9-fictional", preview: "Fictional real-shaped identifier", ephemeral: false,
      createdAt: "2030-01-01T00:00:00.000Z", updatedAt: "2030-01-01T00:01:00.000Z",
      turns: [{ id: "01a11ec6-8d24-7eb0-a000-f92a9972e781", status: "completed", quality: "complete", items: [
        { id: "msg_01a11ec6-8d24-7eb0-a000-f92a9972e781", type: "user_message", text: "我偏好使用完全虚构的蓝色纸飞机示例。", rawType: "userMessage" },
        { id: "msg_01a11ec6-8d24-7eb0-a000-f92a9972e782", type: "assistant_message", phase: "final_answer", text: "收到。", rawType: "agentMessage" },
      ] }],
    };
    expect(inbox.importThreads([thread])).toMatchObject({ sensitiveItemsRedacted: 0, candidatesBlockedSensitive: 0, candidatesCreated: 1 });
    const captured = inbox.inspectThread(thread.id).items[0]!;
    expect(captured.id).toBe(thread.turns[0]!.items[0]!.id);
    expect(captured.sensitive).toBeUndefined();
    expect(captured.redacted).toBeUndefined();
    inbox.close();
  });

  it("expires raw conversations independently while retaining a fresh review candidate", () => {
    const root = mkdtempSync(join(tmpdir(), "open-continuity-capture-retention-")); directories.push(root);
    const inbox = new ConversationInbox(join(root, "capture.db"));
    const old = "2000-01-01T00:00:00.000Z";
    const thread: ConversationThread = {
      source: "trae", id: "thread-expired", sessionId: "session-expired", cwd: "/tmp/fictional-workspace", cliVersion: "9.9.9-fictional",
      preview: "Fictional old thread", ephemeral: false, createdAt: old, updatedAt: old,
      turns: [{ id: "turn-expired", status: "completed", quality: "complete", items: [
        { id: "item-expired", type: "user_message", text: "请记住虚构保留偏好", rawType: "userMessage" },
        { id: "item-expired-final", type: "assistant_message", phase: "final_answer", text: "收到。", rawType: "agentMessage" },
      ] }],
    };
    inbox.importThreads([thread]);
    const pending = inbox.listCandidates()[0]!;
    // Make the candidate fresh relative to this deterministic retention clock.
    const candidateClock = Date.parse(pending.lastSeenAt);
    expect(inbox.cleanupExpired(7, candidateClock + 8 * 24 * 60 * 60 * 1000, 30)).toMatchObject({ threadsDeleted: 1, itemsDeleted: 2, candidatesDeleted: 0 });
    expect(inbox.inspectThread(thread.id).thread).toBeNull();
    expect(inbox.readCheckpoint(thread.id)).toMatchObject({ threadUpdatedAt: thread.updatedAt, lastItemCount: 2 });
    expect(inbox.threadNeedsSync("trae", thread.id, thread.updatedAt)).toBe(false);
    expect(inbox.listCandidates()).toEqual([expect.objectContaining({ id: pending.id })]);
    expect(inbox.cleanupExpired(7, candidateClock + 31 * 24 * 60 * 60 * 1000, 30)).toMatchObject({ threadsDeleted: 0, candidatesDeleted: 1 });
    expect(inbox.listCandidates()).toEqual([]);
    inbox.close();
  });

  it("advances a thread checkpoint atomically with captured items", () => {
    const root = mkdtempSync(join(tmpdir(), "open-continuity-capture-checkpoint-")); directories.push(root);
    const inbox = new ConversationInbox(join(root, "capture.db"));
    const thread: ConversationThread = {
      source: "trae", id: "thread-checkpoint", sessionId: "session-checkpoint", cwd: "/tmp/fictional-workspace", cliVersion: "9.9.9-fictional",
      preview: "Fictional checkpoint", ephemeral: false, createdAt: "2030-01-01T00:00:00.000Z", updatedAt: "2030-01-01T00:01:00.000Z",
      turns: [{ id: "turn-checkpoint", status: "completed", quality: "complete", items: [
        { id: "item-checkpoint", type: "user_message", text: "虚构消息。", rawType: "userMessage" },
      ] }],
    };
    inbox.importThreads([thread]);
    const before = inbox.readCheckpoint(thread.id)!;

    const invalid: ConversationThread = { ...thread, updatedAt: "2030-01-01T00:02:00.000Z", turns: [{ ...thread.turns[0]!, items: [
      ...thread.turns[0]!.items, { id: "item-not-committed", type: "tool_call", toolInput: BigInt(1), rawType: "fictionalToolCall" },
    ] }] };
    expect(() => inbox.importThreads([invalid])).toThrow();
    expect(inbox.readCheckpoint(thread.id)).toEqual(before);
    expect(inbox.inspectThread(thread.id).items.map((item) => item.id)).toEqual(["item-checkpoint"]);
    expect(inbox.threadNeedsSync("trae", thread.id, invalid.updatedAt)).toBe(true);
    inbox.close();
  });

  it("probes a Trae app-server and synchronizes a non-ephemeral fictional thread", async () => {
    const root = mkdtempSync(join(tmpdir(), "open-continuity-capture-adapter-")); directories.push(root);
    const bin = installFakeTraeCli(root);
    const workspace = join(root, "fictional-workspace");
    const env = { ...process.env, HOME: join(root, "home"), OPEN_CONTINUITY_HOME: join(root, "data"), PATH: bin, TEST_TRAE_WORKSPACE: workspace };
    enableCapture(env, workspace);

    expect(captureDoctor(env)).toMatchObject({ ok: true, source: "trae", readiness: "ready_for_sync_or_watch", capabilities: { available: true, appServer: true, version: "traecli 9.9.9-fictional" } });
    const sync = await syncTraeCapture({ limit: 10 }, env);
    expect(sync).toMatchObject({ threadsSeen: 2, threadsImported: 1, turnsImported: 1, itemsImported: 4, candidatesCreated: 1, skippedEphemeral: 1, skippedNotAllowed: 0, pagesScanned: 1, threadIds: [FAKE_TRAE_THREAD_ID] });
    expect(listCaptureCandidates({}, env).candidates[0]).toMatchObject({ threadId: FAKE_TRAE_THREAD_ID, value: "先给结论，再列出验证结果", captureQuality: "complete", status: "pending" });
    expect(captureStatus(env)).toMatchObject({ sync: { consecutive_failures: 0, last_threads_imported: 1, last_pages_scanned: 1 }, checkpoints: { threads: 1, trackedItems: 4 }, candidates: { pending: 1, approved: 0, rejected: 0 } });
  });

  it("protects the worker with a stale-safe single-instance lock", () => {
    const root = mkdtempSync(join(tmpdir(), "open-continuity-capture-lock-")); directories.push(root);
    const env = { ...process.env, HOME: join(root, "home"), OPEN_CONTINUITY_HOME: join(root, "data") };
    const first = acquireCaptureLock(env);
    expect(() => acquireCaptureLock(env)).toThrow(/already running/);
    first.release();
    expect(() => acquireCaptureLock(env)).not.toThrow();
    expect(captureLockPath(env)).toContain("capture.lock");
  });

  it("follows app-server thread list pages", async () => {
    const root = mkdtempSync(join(tmpdir(), "open-continuity-capture-pages-")); directories.push(root);
    const bin = installFakeTraeCli(root);
    const workspace = join(root, "fictional-workspace");
    const env = { ...process.env, HOME: join(root, "home"), OPEN_CONTINUITY_HOME: join(root, "data"), PATH: bin, TEST_TRAE_WORKSPACE: workspace };
    enableCapture(env, workspace);
    const sync = await syncTraeCapture({ limit: 1, maxThreads: 10 }, env);
    expect(sync).toMatchObject({ threadsSeen: 2, pagesScanned: 2, skippedEphemeral: 1, threadsImported: 1 });
  });

  it("requires Capture opt-in and never persists threads outside the workspace allowlist", async () => {
    const root = mkdtempSync(join(tmpdir(), "open-continuity-capture-policy-")); directories.push(root);
    const bin = installFakeTraeCli(root);
    const threadWorkspace = join(root, "fictional-thread-workspace");
    const env = { ...process.env, HOME: join(root, "home"), OPEN_CONTINUITY_HOME: join(root, "data"), PATH: bin, TEST_TRAE_WORKSPACE: threadWorkspace };

    await expect(syncTraeCapture({ limit: 10 }, env)).rejects.toThrow("disabled or has no allowlisted workspace");
    enableCapture(env, join(root, "different-workspace"));
    await expect(syncTraeCapture({ threadId: FAKE_TRAE_THREAD_ID }, env)).rejects.toThrow("not allowlisted for Capture");
    const sync = await syncTraeCapture({ limit: 10 }, env);
    expect(sync).toMatchObject({ threadsSeen: 2, threadsImported: 0, itemsImported: 0, skippedNotAllowed: 1, threadIds: [] });
    expect(listCaptureCandidates({}, env).candidates).toEqual([]);
    expect(captureStatus(env).checkpoints).toMatchObject({ threads: 0, trackedItems: 0 });
  });

  it("renders a restartable launchd service with absolute arguments", () => {
    const root = mkdtempSync(join(tmpdir(), "open-continuity-capture-service-")); directories.push(root);
    const env = { ...process.env, HOME: join(root, "home"), OPEN_CONTINUITY_HOME: join(root, "data") };
    const paths = captureServicePaths(env);
    const plist = renderCaptureServicePlist({ nodePath: "/fictional/node", cliPath: "/fictional/open-continuity/dist/src/cli.js", config: { intervalMs: 1200, pageSize: 7, maxThreads: 42, retryLimit: 2 }, paths, environment: { HOME: "/fictional/home", PATH: "/fictional/bin:/usr/bin", OPEN_CONTINUITY_HOME: "/fictional/data" } });
    expect(plist).toContain("com.opencontinuity.capture");
    expect(plist).toContain("<key>KeepAlive</key><true/>");
    expect(plist).toContain("<string>/fictional/node</string>");
    expect(plist).toContain("<string>1200</string>");
    expect(plist).toContain("<key>EnvironmentVariables</key><dict>");
    expect(plist).toContain("<key>PATH</key><string>/fictional/bin:/usr/bin</string>");
    expect(plist).toContain("<key>HOME</key><string>/fictional/home</string>");
    expect(plist).not.toContain("SECRET_TOKEN");
    expect(plist).toContain(paths.stderrPath);
    const emptyBin = mkdtempSync(join(tmpdir(), "open-continuity-no-launchctl-")); directories.push(emptyBin);
    expect(captureServiceSupported({ ...env, PATH: emptyBin })).toBe(false);
  });

  it("starts an already-loaded capture service idempotently", () => {
    const root = mkdtempSync(join(tmpdir(), "open-continuity-capture-start-")); directories.push(root);
    const env = { ...process.env, UID: "501", HOME: join(root, "home"), OPEN_CONTINUITY_HOME: join(root, "data") };
    expect(installCaptureService({ nodePath: "/fictional/node", cliPath: "/fictional/open-continuity/dist/src/cli.js" }, env)).toMatchObject({ changed: true });
    expect(installCaptureService({ nodePath: "/fictional/node", cliPath: "/fictional/open-continuity/dist/src/cli.js" }, env)).toMatchObject({ changed: false });
    const calls: string[][] = [];
    const runtime: CaptureServiceRuntime = {
      launchctl(args) { calls.push(args); return { ok: true, output: "loaded" }; },
    };

    expect(startCaptureService(env, runtime)).toMatchObject({ status: "running", alreadyRunning: true });
    expect(calls).toEqual([["print", `gui/501/${CAPTURE_SERVICE_LABEL}`]]);
  });

  it("confirms a bootstrapped service is actually registered", () => {
    const root = mkdtempSync(join(tmpdir(), "open-continuity-capture-bootstrap-")); directories.push(root);
    const env = { ...process.env, UID: "501", HOME: join(root, "home"), OPEN_CONTINUITY_HOME: join(root, "data") };
    installCaptureService({ nodePath: "/fictional/node", cliPath: "/fictional/open-continuity/dist/src/cli.js" }, env);
    const registered = [
      { ok: false, output: "not found" },
      { ok: true, output: "" },
      { ok: true, output: "loaded" },
    ];
    expect(startCaptureService(env, { launchctl: () => registered.shift()! })).toMatchObject({ status: "running", alreadyRunning: false });

    const missing = [
      { ok: false, output: "not found" },
      { ok: true, output: "" },
      { ok: false, output: "not found" },
    ];
    expect(() => startCaptureService(env, { launchctl: () => missing.shift()! })).toThrow("Unable to start capture service");
  });

  it("does not report or stop a same-label service loaded from another plist", () => {
    const root = mkdtempSync(join(tmpdir(), "open-continuity-capture-isolation-")); directories.push(root);
    const env = { ...process.env, UID: "501", HOME: join(root, "home"), OPEN_CONTINUITY_HOME: join(root, "data") };
    const loadedElsewhere = { ok: true, output: "path = /fictional/other/Library/LaunchAgents/com.opencontinuity.capture.plist" };

    expect(statusCaptureService(env, { launchctl: () => loadedElsewhere })).toMatchObject({
      installed: false, running: false, differentInstanceRunning: true,
    });
    installCaptureService({ nodePath: "/fictional/node", cliPath: "/fictional/open-continuity/dist/src/cli.js" }, env);
    expect(() => startCaptureService(env, { launchctl: () => loadedElsewhere })).toThrow("different plist");

    const calls: string[][] = [];
    expect(stopCaptureService(env, { launchctl(args) { calls.push(args); return loadedElsewhere; } })).toMatchObject({
      status: "stopped", existed: false, differentInstanceRunning: true,
    });
    expect(calls).toEqual([["print", `gui/501/${CAPTURE_SERVICE_LABEL}`]]);
  });

  it("stops the capture service using one launchd service target", () => {
    const env = { ...process.env, UID: "501" };
    const calls: string[][] = [];
    const responses = [
      { ok: true, output: "loaded" },
      { ok: true, output: "" },
      { ok: false, output: "not found" },
    ];
    const runtime: CaptureServiceRuntime = {
      launchctl(args) { calls.push(args); return responses.shift()!; },
    };

    expect(stopCaptureService(env, runtime)).toMatchObject({ status: "stopped", existed: true });
    expect(calls).toEqual([
      ["print", `gui/501/${CAPTURE_SERVICE_LABEL}`],
      ["bootout", `gui/501/${CAPTURE_SERVICE_LABEL}`],
      ["print", `gui/501/${CAPTURE_SERVICE_LABEL}`],
    ]);
  });

  it("accepts a bootout error only when the service actually disappeared", () => {
    const env = { ...process.env, UID: "501" };
    const target = `gui/501/${CAPTURE_SERVICE_LABEL}`;
    const disappeared = [
      { ok: true, output: "loaded" },
      { ok: false, output: "I/O error" },
      { ok: false, output: "not found" },
    ];
    expect(stopCaptureService(env, { launchctl: () => disappeared.shift()! })).toMatchObject({
      status: "stopped",
      warning: "I/O error",
    });

    const stillLoaded = [
      { ok: true, output: "loaded" },
      { ok: false, output: "I/O error" },
      ...Array.from({ length: 6 }, () => ({ ok: true, output: target })),
    ];
    expect(() => stopCaptureService(env, { launchctl: () => stillLoaded.shift()!, wait: () => undefined })).toThrow("I/O error");

    const successButStillLoaded = [
      { ok: true, output: "loaded" },
      { ok: true, output: "" },
      ...Array.from({ length: 6 }, () => ({ ok: true, output: target })),
    ];
    expect(() => stopCaptureService(env, { launchctl: () => successButStillLoaded.shift()!, wait: () => undefined })).toThrow("still running");
  });

  it("waits briefly for launchd to finish bootout", () => {
    const responses = [
      { ok: true, output: "loaded" },
      { ok: true, output: "" },
      { ok: true, output: "stopping" },
      { ok: false, output: "not found" },
    ];
    let waits = 0;
    expect(stopCaptureService({ ...process.env, UID: "501" }, {
      launchctl: () => responses.shift()!,
      wait: () => { waits += 1; },
    })).toMatchObject({ status: "stopped", existed: true });
    expect(waits).toBe(1);
  });

  it("uninstalls the capture service repeatedly without failing", () => {
    const root = mkdtempSync(join(tmpdir(), "open-continuity-capture-uninstall-")); directories.push(root);
    const env = { ...process.env, UID: "501", HOME: join(root, "home"), OPEN_CONTINUITY_HOME: join(root, "data") };
    installCaptureService({ nodePath: "/fictional/node", cliPath: "/fictional/open-continuity/dist/src/cli.js" }, env);
    const runtime: CaptureServiceRuntime = { launchctl: () => ({ ok: false, output: "not found" }) };

    expect(uninstallCaptureService(env, runtime)).toMatchObject({ status: "uninstalled", installed: false });
    expect(uninstallCaptureService(env, runtime)).toMatchObject({ status: "uninstalled", installed: false, existed: false });
  });
});
