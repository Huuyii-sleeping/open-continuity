import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { installFakeClaudeCli } from "./helpers/fake-claude.js";
import { installFakeTraeCli } from "./helpers/fake-trae.js";

describe("adapter setup compensation transaction", () => {
  const directories: string[] = [];
  afterEach(() => { for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true }); });

  function parseError(stderr: string) {
    return JSON.parse(stderr.trim().split("\n").at(-1)!);
  }

  it("removes a newly connected Claude MCP when hook validation fails", () => {
    const root = mkdtempSync(join(tmpdir(), "open-continuity-claude-rollback-")); directories.push(root);
    const bin = installFakeClaudeCli(root);
    const home = join(root, "home");
    const data = join(root, "data");
    const state = join(root, "state");
    const workspace = join(root, "fictional-workspace");
    const env = { ...process.env, HOME: home, OPEN_CONTINUITY_HOME: data, TEST_STATE_DIR: state, PATH: `${bin}${delimiter}${process.env.PATH || ""}` };
    const cli = join(process.cwd(), "dist/src/cli.js");
    spawnSync(process.execPath, [cli, "init", "--json"], { env, encoding: "utf8" });
    mkdirSync(join(home, ".claude"), { recursive: true });
    const settingsPath = join(home, ".claude", "settings.json");
    const originalSettings = JSON.stringify({ theme: "fictional-dark", hooks: "invalid-user-value" }, null, 2) + "\n";
    writeFileSync(settingsPath, originalSettings);

    const result = spawnSync(process.execPath, [cli, "setup", "claude", "--workspace", workspace, "--json"], { env, encoding: "utf8" });

    expect(result.status).toBe(1);
    const error = parseError(result.stderr);
    expect(error).toMatchObject({ error: { code: "CONFIGURATION_ERROR", details: { transaction: { phase: "rolled_back" } } } });
    expect(error.error.details.transaction.steps).toEqual(expect.arrayContaining([expect.objectContaining({ name: "hooks", status: "failed" })]));
    expect(error.error.details.transaction.rollback).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: "restore_claude_mcp", ok: true }),
      expect.objectContaining({ name: "restore_local_config_and_hooks", ok: true }),
    ]));
    expect(existsSync(join(state, "open_continuity.mcp"))).toBe(false);
    expect(readFileSync(settingsPath, "utf8")).toBe(originalSettings);
    const config = JSON.parse(readFileSync(join(data, "config.json"), "utf8"));
    expect(config.connectedAgents.claude).toBeUndefined();
    expect(config.adapters.claude).toMatchObject({ injection: { enabled: false, workspaces: [] }, capture: { enabled: false, workspaces: [] } });
  });

  it("rolls back Trae MCP, hooks, config, and service files when launchd start fails", () => {
    const root = mkdtempSync(join(tmpdir(), "open-continuity-trae-rollback-")); directories.push(root);
    const bin = installFakeTraeCli(root);
    const home = join(root, "home");
    const data = join(root, "data");
    const state = join(root, "state");
    const traeHome = join(root, "trae-cli");
    const workspace = join(root, "fictional-workspace");
    const env = {
      ...process.env,
      HOME: home,
      OPEN_CONTINUITY_HOME: data,
      TRAECLI_HOME: traeHome,
      TEST_STATE_DIR: state,
      TEST_TRAE_WORKSPACE: workspace,
      TEST_LAUNCHCTL_FAIL_BOOTSTRAP: "1",
      PATH: `${bin}${delimiter}${process.env.PATH || ""}`,
    };
    const cli = join(process.cwd(), "dist/src/cli.js");
    spawnSync(process.execPath, [cli, "init", "--json"], { env, encoding: "utf8" });

    const result = spawnSync(process.execPath, [cli, "setup", "trae", "--workspace", workspace, "--json"], { env, encoding: "utf8" });

    expect(result.status).toBe(1);
    const error = parseError(result.stderr);
    expect(error).toMatchObject({ error: { code: "CONFIGURATION_ERROR", details: { transaction: { phase: "rolled_back" } } } });
    expect(error.error.details.transaction.steps).toEqual(expect.arrayContaining([expect.objectContaining({ name: "service", status: "failed" })]));
    expect(error.error.details.transaction.rollback).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: "restore_capture_service", ok: true }),
      expect.objectContaining({ name: "restore_trae_mcp", ok: true }),
      expect.objectContaining({ name: "restore_local_config_and_hooks", ok: true }),
    ]));
    expect(existsSync(join(state, "open_continuity.mcp"))).toBe(false);
    expect(existsSync(join(state, "capture.launchd"))).toBe(false);
    expect(existsSync(join(traeHome, "hooks.json"))).toBe(false);
    expect(existsSync(join(data, "hook-manifest.json"))).toBe(false);
    expect(existsSync(join(home, "Library", "LaunchAgents", "com.opencontinuity.capture.plist"))).toBe(false);
    const config = JSON.parse(readFileSync(join(data, "config.json"), "utf8"));
    expect(config.connectedAgents.trae).toBeUndefined();
    expect(config.adapters.trae).toMatchObject({ injection: { enabled: false, workspaces: [] }, capture: { enabled: false, workspaces: [] } });
  });
});
