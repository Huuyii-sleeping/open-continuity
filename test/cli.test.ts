import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { installFakeTraeCli } from "./helpers/fake-trae.js";

describe("CLI", () => {
  const directories: string[] = [];
  afterEach(() => { for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true }); });

  it("initializes an isolated local runtime and passes doctor probes", () => {
    const root = mkdtempSync(join(tmpdir(), "open-continuity-cli-")); directories.push(root);
    const env = { ...process.env, HOME: join(root, "home"), OPEN_CONTINUITY_HOME: join(root, "data"), PATH: process.env.PATH };
    const cli = join(process.cwd(), "dist/src/cli.js");
    const initialized = JSON.parse(execFileSync(process.execPath, [cli, "init", "--json"], { env, encoding: "utf8" }));
    expect(initialized).toMatchObject({ ok: true, created: true });
    const config = JSON.parse(readFileSync(join(root, "data/config.json"), "utf8"));
    expect(config.userId).toMatch(/^local-/);
    const doctor = JSON.parse(execFileSync(process.execPath, [cli, "doctor", "--json"], { env, encoding: "utf8" }));
    expect(doctor.ok).toBe(true);
    expect(doctor.checks).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: "MCP startup", status: "pass" }),
      expect.objectContaining({ name: "Tool discovery", status: "pass", detail: "9 tools available" }),
      expect.objectContaining({ name: "Database read probe", status: "pass" }),
    ]));
  }, 15_000);

  it("checks, backs up, and restores the configured SQLite database", () => {
    const root = mkdtempSync(join(tmpdir(), "open-continuity-cli-maintenance-")); directories.push(root);
    const env = { ...process.env, HOME: join(root, "home"), OPEN_CONTINUITY_HOME: join(root, "data"), PATH: process.env.PATH };
    const cli = join(process.cwd(), "dist/src/cli.js");
    execFileSync(process.execPath, [cli, "init", "--json"], { env, encoding: "utf8" });
    const checked = JSON.parse(execFileSync(process.execPath, [cli, "database", "check", "--json"], { env, encoding: "utf8" }));
    expect(checked).toMatchObject({ ok: true, recognized: true, supportedSchema: true, memories: 0, events: 0 });

    const backup = join(root, "backup.db");
    const backedUp = JSON.parse(execFileSync(process.execPath, [cli, "database", "backup", "--output", backup, "--json"], { env, encoding: "utf8" }));
    expect(backedUp).toMatchObject({ ok: true, operation: "database_backup", output: backup });
    expect(existsSync(backup)).toBe(true);

    const restoredPath = join(root, "restored.db");
    const restored = JSON.parse(execFileSync(process.execPath, [cli, "database", "restore", backup, "--output", restoredPath, "--yes", "--json"], { env, encoding: "utf8" }));
    expect(restored).toMatchObject({ ok: true, operation: "database_restore", databasePath: restoredPath, previousDatabasePath: join(root, "data/memories.db"), agentsToReconnect: [], status: { ok: true } });
    const config = JSON.parse(readFileSync(join(root, "data/config.json"), "utf8"));
    expect(config.databasePath).toBe(restoredPath);
    expect(existsSync(restored.previousDatabasePath)).toBe(true);
  }, 15_000);

  it("runs a disposable two-Agent MCP memory and handoff demo", () => {
    const cli = join(process.cwd(), "dist/src/cli.js");
    const result = JSON.parse(execFileSync(process.execPath, [cli, "demo", "--json"], { encoding: "utf8" }));
    expect(result).toMatchObject({
      ok: true,
      mode: "isolated",
      transport: "MCP stdio",
      tools: 9,
      sharedMemory: {
        key: "response_style",
        value: "Use concise summaries and list verification results.",
        writtenBy: "demo-agent-a",
        readBy: "demo-agent-b",
        persistedAcrossAgentRestart: true,
      },
      handoff: {
        createdBy: "demo-agent-a",
        resumedBy: "demo-agent-b",
        status: "ready",
        summary: "The shared-memory demo is ready for the second agent.",
      },
      cleanup: { temporaryDatabaseRemoved: true },
    });
  }, 15_000);

  it("syncs, reviews, and approves a fictional Trae conversation candidate", () => {
    const root = mkdtempSync(join(tmpdir(), "open-continuity-cli-capture-")); directories.push(root);
    const bin = installFakeTraeCli(root);
    const env = { ...process.env, HOME: join(root, "home"), OPEN_CONTINUITY_HOME: join(root, "data"), PATH: `${bin}${delimiter}${process.env.PATH || ""}` };
    const cli = join(process.cwd(), "dist/src/cli.js");
    execFileSync(process.execPath, [cli, "init", "--json"], { env, encoding: "utf8" });

    const doctor = JSON.parse(execFileSync(process.execPath, [cli, "capture", "doctor", "--json"], { env, encoding: "utf8" }));
    expect(doctor).toMatchObject({ ok: true, readiness: "ready_for_sync_or_watch" });
    const sync = JSON.parse(execFileSync(process.execPath, [cli, "capture", "sync", "--limit", "10", "--json"], { env, encoding: "utf8" }));
    expect(sync).toMatchObject({ threadsImported: 1, candidatesCreated: 1 });
    const watch = JSON.parse(execFileSync(process.execPath, [cli, "capture", "watch", "--once", "--limit", "10", "--json"], { env, encoding: "utf8" }));
    expect(watch).toMatchObject({ ok: true, operation: "capture_watch_cycle", cycle: 1, threadsImported: 0, skippedUnchanged: 1, threadIds: [] });
    const thread = JSON.parse(execFileSync(process.execPath, [cli, "capture", "thread", sync.threadIds[0], "--json"], { env, encoding: "utf8" }));
    expect(thread.items.map((item: { type: string }) => item.type)).toEqual(["user_message", "assistant_message", "tool_call", "assistant_message"]);

    const candidates = JSON.parse(execFileSync(process.execPath, [cli, "capture", "candidates", "--json"], { env, encoding: "utf8" }));
    expect(candidates.candidates).toHaveLength(1);
    const candidateId = candidates.candidates[0].id;
    const approved = JSON.parse(execFileSync(process.execPath, [cli, "capture", "approve", candidateId, "--share", "--json"], { env, encoding: "utf8" }));
    expect(approved).toMatchObject({ duplicate: false, candidate: { status: "approved", sensitivity: "public" } });

    const memories = JSON.parse(execFileSync(process.execPath, [cli, "memories", "list", "--json"], { env, encoding: "utf8" }));
    expect(memories.memories).toHaveLength(1);
    expect(memories.memories[0]).toMatchObject({ value: "先给结论，再列出验证结果", sourceAgentId: "trae-capture", sensitivity: "public" });
  }, 15_000);

  it("manages the local Injection allowlist without touching Agent configuration", () => {
    const root = mkdtempSync(join(tmpdir(), "open-continuity-cli-injection-")); directories.push(root);
    const workspace = join(root, "fictional-workspace");
    const env = { ...process.env, HOME: join(root, "home"), OPEN_CONTINUITY_HOME: join(root, "data"), PATH: process.env.PATH };
    const cli = join(process.cwd(), "dist/src/cli.js");
    execFileSync(process.execPath, [cli, "init", "--json"], { env, encoding: "utf8" });

    const enabled = JSON.parse(execFileSync(process.execPath, [cli, "injection", "enable", workspace, "--json"], { env, encoding: "utf8" }));
    expect(enabled).toMatchObject({ ok: true, operation: "injection_enable", config: { enabled: true, workspaces: [workspace] } });
    const status = JSON.parse(execFileSync(process.execPath, [cli, "injection", "status", "--json"], { env, encoding: "utf8" }));
    expect(status).toMatchObject({ ok: true, operation: "injection_status", config: { enabled: true, workspaces: [workspace] }, hook: { event: "UserPromptSubmit", exists: false, installed: false } });

    const installed = JSON.parse(execFileSync(process.execPath, [cli, "injection", "install-hook", "--json"], { env: { ...env, TRAECLI_HOME: join(root, "trae-cli") }, encoding: "utf8" }));
    expect(installed).toMatchObject({ ok: true, operation: "injection_install_hook", changed: true, installed: true });
    const checked = JSON.parse(execFileSync(process.execPath, [cli, "injection", "check-hook", "--json"], { env: { ...env, TRAECLI_HOME: join(root, "trae-cli") }, encoding: "utf8" }));
    expect(checked).toMatchObject({ ok: true, operation: "injection_check_hook", exists: true, valid: true, installed: true });
    const installedAgain = JSON.parse(execFileSync(process.execPath, [cli, "injection", "install-hook", "--json"], { env: { ...env, TRAECLI_HOME: join(root, "trae-cli") }, encoding: "utf8" }));
    expect(installedAgain).toMatchObject({ ok: true, changed: false, installed: true });

    const disabled = JSON.parse(execFileSync(process.execPath, [cli, "injection", "disable", "--json"], { env, encoding: "utf8" }));
    expect(disabled).toMatchObject({ ok: true, operation: "injection_disable", config: { enabled: false, workspaces: [workspace] } });
  }, 15_000);

  it("sets up and diagnoses the complete Trae adapter idempotently", () => {
    const root = mkdtempSync(join(tmpdir(), "open-continuity-cli-trae-setup-")); directories.push(root);
    const bin = installFakeTraeCli(root);
    const workspace = join(root, "fictional-workspace");
    const env = {
      ...process.env, HOME: join(root, "home"), OPEN_CONTINUITY_HOME: join(root, "data"), TRAECLI_HOME: join(root, "trae-cli"),
      TEST_STATE_DIR: join(root, "state"), PATH: `${bin}${delimiter}${process.env.PATH || ""}`,
    };
    const cli = join(process.cwd(), "dist/src/cli.js");

    const first = JSON.parse(execFileSync(process.execPath, [cli, "setup", "trae", "--workspace", workspace, "--json"], { env, encoding: "utf8" }));
    expect(first).toMatchObject({
      ok: true, operation: "setup_trae", workspace,
      steps: { mcp: { changed: true }, injection: { enabled: true, hookChanged: true }, captureService: { installed: true, status: "running", alreadyRunning: false } },
      doctor: { adapter: "trae", ok: true },
    });
    expect(first.doctor.checks).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: "Trae installation", status: "pass" }),
      expect.objectContaining({ name: "Trae MCP connector", status: "pass" }),
      expect.objectContaining({ name: "Trae UserPromptSubmit hook", status: "pass" }),
      expect.objectContaining({ name: "Capture background service", status: "pass" }),
      expect.objectContaining({ name: "Trae Hook trust", status: "warn" }),
    ]));

    const second = JSON.parse(execFileSync(process.execPath, [cli, "setup", "trae", "--workspace", workspace, "--json"], { env, encoding: "utf8" }));
    expect(second).toMatchObject({
      ok: true, steps: { mcp: { changed: false }, injection: { hookChanged: false }, captureService: { configChanged: false, reloaded: false, alreadyRunning: true } },
    });

    const configPath = join(root, "data/config.json");
    const config = JSON.parse(readFileSync(configPath, "utf8"));
    config.capture.intervalMs = 6000;
    writeFileSync(configPath, JSON.stringify(config, null, 2) + "\n");
    const reloaded = JSON.parse(execFileSync(process.execPath, [cli, "setup", "trae", "--workspace", workspace, "--json"], { env, encoding: "utf8" }));
    expect(reloaded).toMatchObject({
      ok: true, steps: { captureService: { configChanged: true, reloaded: true, alreadyRunning: false } },
    });

    const doctor = JSON.parse(execFileSync(process.execPath, [cli, "doctor", "trae", "--workspace", workspace, "--json"], { env, encoding: "utf8" }));
    expect(doctor).toMatchObject({ ok: true, adapter: "trae" });
    expect(doctor.manualActions).toHaveLength(2);
  }, 30_000);

  it("reports capture state and renders the local service configuration", () => {
    const root = mkdtempSync(join(tmpdir(), "open-continuity-cli-capture-service-")); directories.push(root);
    const env = { ...process.env, HOME: join(root, "home"), OPEN_CONTINUITY_HOME: join(root, "data"), PATH: process.env.PATH };
    const cli = join(process.cwd(), "dist/src/cli.js");
    execFileSync(process.execPath, [cli, "init", "--json"], { env, encoding: "utf8" });
    const status = JSON.parse(execFileSync(process.execPath, [cli, "capture", "status", "--json"], { env, encoding: "utf8" }));
    expect(status).toMatchObject({ ok: true, operation: "capture_status", lock: { locked: false }, service: { installed: false, running: false } });
    const installed = JSON.parse(execFileSync(process.execPath, [cli, "capture", "service", "install", "--json"], { env, encoding: "utf8" }));
    expect(installed).toMatchObject({ ok: true, operation: "capture_service_install", installed: true });
    expect(existsSync(installed.paths.plistPath)).toBe(true);
    const serviceStatus = JSON.parse(execFileSync(process.execPath, [cli, "capture", "service", "status", "--json"], { env, encoding: "utf8" }));
    expect(serviceStatus).toMatchObject({ ok: true, operation: "capture_service_status", installed: true, running: false });
    const removed = JSON.parse(execFileSync(process.execPath, [cli, "capture", "service", "uninstall", "--json"], { env, encoding: "utf8" }));
    expect(removed).toMatchObject({ ok: true, operation: "capture_service_uninstall", installed: false });
  }, 15_000);
});
