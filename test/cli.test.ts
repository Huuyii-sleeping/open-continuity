import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

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
});
