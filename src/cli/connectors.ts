import { accessSync, constants, copyFileSync, existsSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { basename, delimiter, join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import type { AgentName, LocalConfig } from "./config.js";
import { continuityHome, saveConfig } from "./config.js";

export const MCP_SERVER_NAME = "open_continuity";

interface Connector { candidates: string[]; configPath: (env: NodeJS.ProcessEnv) => string; addArgs: (serverPath: string, config: LocalConfig) => string[]; removeArgs: string[]; getArgs: string[]; }
const userHome = (env: NodeJS.ProcessEnv): string => env.HOME || homedir();

const commonEnv = (config: LocalConfig, agent: AgentName): string[] => [
  "--env", "OPEN_CONTINUITY_PROFILE=lite", "--env", "OPEN_CONTINUITY_STORE=sqlite",
  "--env", `OPEN_CONTINUITY_SQLITE_PATH=${config.databasePath}`, "--env", `OPEN_CONTINUITY_USER_ID=${config.userId}`,
  "--env", `OPEN_CONTINUITY_AGENT_ID=${agent}`, "--env", "OPEN_CONTINUITY_ALLOW_PRIVATE=false",
];

const connectors: Record<AgentName, Connector> = {
  trae: {
    candidates: ["traecli", "traex"], configPath: (env) => join(env.TRAE_HOME || userHome(env), env.TRAE_HOME ? "traecli.toml" : ".trae/traecli.toml"),
    addArgs: (server, config) => ["mcp", "add", MCP_SERVER_NAME, ...commonEnv(config, "trae"), "--", process.execPath, server, "--mcp"],
    removeArgs: ["mcp", "remove", MCP_SERVER_NAME], getArgs: ["mcp", "get", MCP_SERVER_NAME],
  },
  codex: {
    candidates: ["codex"], configPath: (env) => join(env.CODEX_HOME || join(userHome(env), ".codex"), "config.toml"),
    addArgs: (server, config) => ["mcp", "add", MCP_SERVER_NAME, ...commonEnv(config, "codex"), "--", process.execPath, server, "--mcp"],
    removeArgs: ["mcp", "remove", MCP_SERVER_NAME], getArgs: ["mcp", "get", MCP_SERVER_NAME],
  },
  claude: {
    candidates: ["claude"], configPath: (env) => join(userHome(env), ".claude.json"),
    addArgs: (server, config) => ["mcp", "add", "--scope", "user", "--transport", "stdio", ...commonEnv(config, "claude"), MCP_SERVER_NAME, "--", process.execPath, server, "--mcp"],
    removeArgs: ["mcp", "remove", "--scope", "user", MCP_SERVER_NAME], getArgs: ["mcp", "get", MCP_SERVER_NAME],
  },
};

export function findExecutable(candidates: string[], env: NodeJS.ProcessEnv = process.env): string | null {
  for (const candidate of candidates) {
    if (candidate.includes("/")) { try { accessSync(candidate, constants.X_OK); return resolve(candidate); } catch { continue; } }
    for (const directory of (env.PATH || "").split(delimiter).filter(Boolean)) {
      const path = join(directory, candidate);
      try { accessSync(path, constants.X_OK); return path; } catch { /* keep searching */ }
    }
  }
  return null;
}

function run(binary: string, args: string[], env: NodeJS.ProcessEnv): { ok: boolean; output: string } {
  const result = spawnSync(binary, args, { env, encoding: "utf8", timeout: 30_000 });
  return { ok: result.status === 0, output: [result.stdout, result.stderr, result.error?.message].filter(Boolean).join("\n").trim() };
}

function backupConfig(agent: AgentName, connector: Connector, env: NodeJS.ProcessEnv): string | undefined {
  const source = connector.configPath(env);
  if (!existsSync(source)) return undefined;
  const directory = join(continuityHome(env), "backups");
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const target = join(directory, `${agent}-${new Date().toISOString().replaceAll(":", "-")}-${basename(source)}`);
  copyFileSync(source, target);
  return target;
}

export function detectAgents(env: NodeJS.ProcessEnv = process.env): Record<AgentName, string | null> {
  return { trae: findExecutable(connectors.trae.candidates, env), claude: findExecutable(connectors.claude.candidates, env), codex: findExecutable(connectors.codex.candidates, env) };
}

export function connectAgent(agent: AgentName, config: LocalConfig, serverPath: string, env: NodeJS.ProcessEnv = process.env, force = false): { backupPath?: string; binary: string } {
  if (serverPath.split(/[\\/]/).includes("_npx")) throw new Error("Refusing to persist an ephemeral npx cache path. Install OpenContinuity globally or in a durable project before connecting an Agent.");
  const connector = connectors[agent];
  const binary = findExecutable(connector.candidates, env);
  if (!binary) throw new Error(`${agent} CLI was not found in PATH.`);
  const existing = run(binary, connector.getArgs, env);
  if (existing.ok && !force) throw new Error(`${MCP_SERVER_NAME} is already configured in ${agent}. Use --force to replace it safely.`);
  const backupPath = backupConfig(agent, connector, env);
  if (existing.ok && !backupPath) throw new Error(`Refusing to replace ${agent}: its active configuration could not be located for backup.`);
  if (existing.ok) {
    const removed = run(binary, connector.removeArgs, env);
    if (!removed.ok) throw new Error(`Unable to remove the existing ${agent} configuration: ${removed.output}`);
  }
  const added = run(binary, connector.addArgs(serverPath, config), env);
  if (!added.ok) {
    if (backupPath) {
      run(binary, connector.removeArgs, env);
      copyFileSync(backupPath, connector.configPath(env));
    }
    throw new Error(`Unable to connect ${agent}; the previous configuration was restored: ${added.output}`);
  }
  config.connectedAgents[agent] = { binary, connectedAt: new Date().toISOString(), databasePath: config.databasePath, serverPath: resolve(serverPath), nodePath: process.execPath, ...(backupPath ? { backupPath } : {}) };
  try { saveConfig(config, env); } catch (error) {
    run(binary, connector.removeArgs, env);
    if (backupPath) copyFileSync(backupPath, connector.configPath(env));
    delete config.connectedAgents[agent];
    throw error;
  }
  return { binary, backupPath };
}

export function disconnectAgent(agent: AgentName, config: LocalConfig, env: NodeJS.ProcessEnv = process.env): void {
  const connector = connectors[agent];
  const binary = config.connectedAgents[agent]?.binary || findExecutable(connector.candidates, env);
  if (!binary) throw new Error(`${agent} CLI was not found in PATH.`);
  const result = run(binary, connector.removeArgs, env);
  if (!result.ok) throw new Error(`Unable to disconnect ${agent}: ${result.output}`);
  delete config.connectedAgents[agent];
  saveConfig(config, env);
}

export function connectorStatus(agent: AgentName, config: LocalConfig, env: NodeJS.ProcessEnv = process.env, expectedRuntime?: { serverPath: string; nodePath?: string }): { detected: boolean; configured: boolean; detail?: string } {
  const connector = connectors[agent];
  const binary = config.connectedAgents[agent]?.binary || findExecutable(connector.candidates, env);
  if (!binary) return { detected: false, configured: false, detail: "CLI not found" };
  const connectedDatabasePath = config.connectedAgents[agent]?.databasePath;
  if (connectedDatabasePath && connectedDatabasePath !== config.databasePath) {
    return { detected: true, configured: false, detail: "configured for a previous database; reconnect with --force" };
  }
  const result = run(binary, connector.getArgs, env);
  const connection = config.connectedAgents[agent];
  if (result.ok && connection && expectedRuntime && (connection.serverPath !== resolve(expectedRuntime.serverPath) || connection.nodePath !== (expectedRuntime.nodePath ?? process.execPath))) {
    return { detected: true, configured: false, detail: "configured for a previous OpenContinuity runtime; reconnect with --force" };
  }
  return { detected: true, configured: result.ok, ...(result.ok ? {} : { detail: result.output || "MCP server not configured" }) };
}
