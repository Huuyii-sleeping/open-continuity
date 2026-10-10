import { chmodSync, existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { defaultConfig } from "../src/cli/config.js";
import { connectAgent, connectorStatus, disconnectAgent } from "../src/cli/connectors.js";

describe("agent connectors", () => {
  const directories: string[] = [];
  afterEach(() => { for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true }); });

  function environment() {
    const root = mkdtempSync(join(tmpdir(), "open-continuity-connectors-")); directories.push(root);
    const bin = join(root, "bin"); const state = join(root, "state"); mkdirSync(bin); mkdirSync(state);
    const script = `#!/bin/sh
name="$4"
case "$1 $2" in
  "mcp get") test -f "$TEST_STATE_DIR/$3" ;;
  "mcp add") printf '%s\n' "$@" > "$TEST_STATE_DIR/args"; touch "$TEST_STATE_DIR/$3" ;;
  "mcp remove") rm -f "$TEST_STATE_DIR/$3" ;;
  *) exit 2 ;;
esac
`;
    for (const name of ["traecli", "codex"]) { const path = join(bin, name); writeFileSync(path, script); chmodSync(path, 0o755); }
    const home = join(root, "home"); mkdirSync(join(home, ".trae"), { recursive: true });
    const env = { ...process.env, HOME: home, OPEN_CONTINUITY_HOME: join(home, ".open-continuity"), PATH: `${bin}:${process.env.PATH}`, TEST_STATE_DIR: state };
    return { root, state, home, env };
  }

  it("backs up an existing config, writes fixed identity settings, and disconnects", () => {
    const { state, home, env } = environment();
    const configPath = join(home, ".trae/traecli.toml"); writeFileSync(configPath, "model = \"demo\"\n");
    const config = defaultConfig(env);
    const connected = connectAgent("trae", config, "/tmp/open-continuity/server.js", env);
    expect(connected.backupPath && existsSync(connected.backupPath)).toBe(true);
    expect(readFileSync(connected.backupPath!, "utf8")).toContain("model");
    const argumentsText = readFileSync(join(state, "args"), "utf8");
    expect(argumentsText).toContain(`OPEN_CONTINUITY_USER_ID=${config.userId}`);
    expect(argumentsText).toContain("OPEN_CONTINUITY_AGENT_ID=trae");
    expect(config.connectedAgents.trae).toMatchObject({ databasePath: config.databasePath });
    expect(connectorStatus("trae", config, env)).toMatchObject({ detected: true, configured: true });
    expect(connectorStatus("trae", config, env, { serverPath: "/tmp/other-install/server.js", nodePath: process.execPath })).toMatchObject({ detected: true, configured: false, detail: expect.stringContaining("previous OpenContinuity runtime") });
    config.databasePath = join(home, "restored.db");
    expect(connectorStatus("trae", config, env)).toMatchObject({ detected: true, configured: false, detail: expect.stringContaining("previous database") });
    config.databasePath = config.connectedAgents.trae!.databasePath!;
    disconnectAgent("trae", config, env);
    expect(connectorStatus("trae", config, env)).toMatchObject({ detected: true, configured: false });
  });

  it("refuses to replace an unmanaged existing server without force", () => {
    const { state, env } = environment();
    writeFileSync(join(state, "open_continuity"), "");
    const config = defaultConfig(env);
    expect(() => connectAgent("trae", config, "/tmp/server.js", env)).toThrow("--force");
  });

  it("refuses to persist an ephemeral npx cache path", () => {
    const { env } = environment();
    expect(() => connectAgent("trae", defaultConfig(env), "/tmp/.npm/_npx/demo/node_modules/open-continuity/dist/src/server.js", env)).toThrow("ephemeral npx cache");
  });
});
