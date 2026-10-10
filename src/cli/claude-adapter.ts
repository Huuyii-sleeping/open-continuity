import { existsSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { isWorkspaceAllowed, normalizeWorkspacePath, saveConfig, type LocalConfig } from "./config.js";
import { connectAgent, connectorStatus, findExecutable } from "./connectors.js";
import { runDoctor, type DoctorCheck } from "./doctor.js";
import { ConversationInbox } from "../capture/conversation-inbox.js";
import { captureDatabasePath } from "../capture/paths.js";
import { checkClaudeHooks, installClaudeHooks, type ClaudeHookPaths } from "../injection/claude-hook-config.js";
import { SqliteMemoryStore } from "../sqlite/sqlite-memory-store.js";

export interface ClaudeAdapterPaths extends ClaudeHookPaths {
  serverPath: string;
  nodePath: string;
}

function check(name: string, status: DoctorCheck["status"], detail: string): DoctorCheck {
  return { name, status, detail };
}

function probeClaude(env: NodeJS.ProcessEnv): { binary: string | null; version: string | null } {
  const binary = findExecutable(["claude"], env);
  if (!binary) return { binary: null, version: null };
  const result = spawnSync(binary, ["--version"], { env, encoding: "utf8", timeout: 10_000 });
  return { binary, version: [result.stdout, result.stderr].filter(Boolean).join(" ").trim() || null };
}

export async function doctorClaudeAdapter(
  config: LocalConfig,
  paths: ClaudeAdapterPaths,
  env: NodeJS.ProcessEnv = process.env,
  workspace?: string,
): Promise<{ ok: boolean; adapter: "claude"; checks: DoctorCheck[]; manualActions: string[] }> {
  const checks: DoctorCheck[] = [];
  const capabilities = probeClaude(env);
  checks.push(check("Claude Code installation", capabilities.binary ? "pass" : "fail", capabilities.version || capabilities.binary || "Claude Code executable not found"));

  const connector = connectorStatus("claude", config, env, { serverPath: paths.serverPath, nodePath: paths.nodePath });
  const managed = Boolean(config.connectedAgents.claude);
  checks.push(check("Claude MCP connector", connector.configured && managed ? "pass" : "fail",
    connector.configured ? (managed ? "OpenContinuity MCP is configured and locally managed" : "an unmanaged OpenContinuity MCP entry already exists; rerun setup with --force") : connector.detail || "not configured"));

  const generic = await runDoctor(config, paths.serverPath, env);
  checks.push(...generic.checks.filter((entry) => ["MCP startup", "Tool discovery", "Capability probe", "Database read probe"].includes(entry.name))
    .map((entry) => ({ ...entry, name: `OpenContinuity ${entry.name}` })));

  const hooks = checkClaudeHooks(env, paths.nodePath, paths);
  checks.push(check("Claude UserPromptSubmit hook", hooks.valid && hooks.injectionInstalled && existsSync(paths.injectionHookPath) ? "pass" : "fail",
    hooks.injectionInstalled ? (existsSync(paths.injectionHookPath) ? hooks.path : `hook entry exists but executable is missing: ${paths.injectionHookPath}`) : hooks.detail || "not installed"));
  checks.push(check("Claude Stop Capture hook", hooks.valid && hooks.captureInstalled && existsSync(paths.captureHookPath) ? "pass" : "fail",
    hooks.captureInstalled ? (existsSync(paths.captureHookPath) ? hooks.path : `hook entry exists but executable is missing: ${paths.captureHookPath}`) : hooks.detail || "not installed"));

  const normalizedWorkspace = workspace ? normalizeWorkspacePath(workspace) : undefined;
  const injectionAllowed = normalizedWorkspace
    ? isWorkspaceAllowed(config.injection.workspaces, normalizedWorkspace)
    : config.injection.workspaces.length > 0;
  checks.push(check("Injection allowlist", config.injection.enabled && injectionAllowed ? "pass" : "fail",
    !config.injection.enabled ? "injection is disabled" : normalizedWorkspace && !injectionAllowed ? `${normalizedWorkspace} is not allowlisted` : `${config.injection.workspaces.length} workspace(s) allowlisted`));
  const captureAllowed = normalizedWorkspace
    ? isWorkspaceAllowed(config.capture.workspaces, normalizedWorkspace)
    : config.capture.workspaces.length > 0;
  checks.push(check("Capture allowlist", config.capture.enabled && captureAllowed ? "pass" : "fail",
    !config.capture.enabled ? "capture is disabled" : normalizedWorkspace && !captureAllowed ? `${normalizedWorkspace} is not allowlisted` : `${config.capture.workspaces.length} workspace(s) allowlisted`));

  const inbox = new ConversationInbox(captureDatabasePath(env));
  try {
    const sync = inbox.readSyncState("claude");
    const checkpoints = inbox.checkpointStatus("claude");
    const failures = Number(sync?.consecutive_failures ?? 0);
    checks.push(check("Claude Capture health", failures > 0 ? "fail" : sync?.last_success_at ? "pass" : "warn",
      failures > 0 ? `${failures} consecutive failure(s): ${String(sync?.last_warning || "unknown error")}` : sync?.last_success_at ? `last success: ${String(sync.last_success_at)}` : "Stop hook has not captured its first completed turn yet"));
    checks.push(check("Claude Capture checkpoints", checkpoints.threads > 0 ? "pass" : "warn",
      checkpoints.threads > 0 ? `${checkpoints.threads} session(s), ${checkpoints.trackedItems} item(s)` : "no durable Claude session checkpoint yet"));
  } finally {
    inbox.close();
  }

  const manualActions = [
    "Restart active Claude Code sessions after setup so the new user-level hooks are loaded.",
    "Keep normal MCP approval enabled, or approve OpenContinuity read tools when Claude requests deep memory search.",
  ];
  return { ok: checks.every((entry) => entry.status !== "fail"), adapter: "claude", checks, manualActions };
}

export async function setupClaudeAdapter(
  config: LocalConfig,
  paths: ClaudeAdapterPaths,
  input: { workspace: string; force?: boolean },
  env: NodeJS.ProcessEnv = process.env,
) {
  const workspace = normalizeWorkspacePath(input.workspace);
  const capabilities = probeClaude(env);
  if (!capabilities.binary) throw new Error("Claude Code executable was not found in PATH");
  new SqliteMemoryStore(config.databasePath).close();

  const before = connectorStatus("claude", config, env, { serverPath: paths.serverPath, nodePath: paths.nodePath });
  const managed = Boolean(config.connectedAgents.claude);
  let mcp: { changed: boolean; binary?: string; backupPath?: string } = { changed: false };
  if (!before.configured || !managed) {
    if (before.configured && !managed && !input.force) {
      throw new Error("An unmanaged open_continuity MCP entry already exists in Claude. Rerun with --force after reviewing it.");
    }
    mcp = { changed: true, ...connectAgent("claude", config, paths.serverPath, env, Boolean(input.force || managed)) };
  }

  const hooks = installClaudeHooks(env, paths.nodePath, paths);
  config.injection = {
    ...config.injection,
    enabled: true,
    workspaces: [...new Set([...config.injection.workspaces.map(normalizeWorkspacePath), workspace])],
  };
  config.capture = {
    ...config.capture,
    enabled: true,
    workspaces: [...new Set([...config.capture.workspaces.map(normalizeWorkspacePath), workspace])],
  };
  saveConfig(config, env);
  const doctor = await doctorClaudeAdapter(config, paths, env, workspace);
  return {
    ok: doctor.ok,
    operation: "setup_claude",
    adapter: "claude",
    workspace,
    steps: {
      captureCapability: { ok: true, mode: "Stop transcript hook", version: capabilities.version },
      mcp,
      injection: { enabled: true, hookChanged: hooks.changed, hookPath: paths.injectionHookPath },
      capture: { enabled: true, hookChanged: hooks.changed, hookPath: paths.captureHookPath, workspaces: config.capture.workspaces },
    },
    doctor,
  };
}
