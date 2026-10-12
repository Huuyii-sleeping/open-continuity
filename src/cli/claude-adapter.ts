import { spawnSync } from "node:child_process";
import { adapterCaptureConfig, adapterInjectionConfig, configPath, isWorkspaceAllowed, normalizeWorkspacePath, saveConfig, type LocalConfig } from "./config.js";
import { connectAgent, connectorStatus, findExecutable, rollbackAgentConnection } from "./connectors.js";
import { runDoctor, type DoctorCheck } from "./doctor.js";
import { ConversationInbox } from "../capture/conversation-inbox.js";
import { captureDatabasePath } from "../capture/paths.js";
import { checkClaudeHooks, claudeSettingsPath, installClaudeHooks, type ClaudeHookPaths } from "../injection/claude-hook-config.js";
import { SqliteMemoryStore } from "../sqlite/sqlite-memory-store.js";
import { isRegularHookFile } from "../injection/hook-health.js";
import { hookManifestPath } from "../injection/hook-manifest.js";
import { restoreFile, restoreObject, SetupTransaction, snapshotFile } from "./setup-transaction.js";

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
  const injection = adapterInjectionConfig(config, "claude");
  const captureConfig = adapterCaptureConfig(config, "claude");
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
  checks.push(check("Claude UserPromptSubmit hook", hooks.valid && hooks.injectionInstalled && isRegularHookFile(paths.injectionHookPath) ? "pass" : "fail",
    hooks.injectionInstalled ? (isRegularHookFile(paths.injectionHookPath) ? hooks.path : `hook entry exists but executable is missing: ${paths.injectionHookPath}`) : hooks.detail || "not installed"));
  checks.push(check("Claude Stop Capture hook", hooks.valid && hooks.captureInstalled && isRegularHookFile(paths.captureHookPath) ? "pass" : "fail",
    hooks.captureInstalled ? (isRegularHookFile(paths.captureHookPath) ? hooks.path : `hook entry exists but executable is missing: ${paths.captureHookPath}`) : hooks.detail || "not installed"));

  const normalizedWorkspace = workspace ? normalizeWorkspacePath(workspace) : undefined;
  const injectionAllowed = normalizedWorkspace
    ? isWorkspaceAllowed(injection.workspaces, normalizedWorkspace)
    : injection.workspaces.length > 0;
  checks.push(check("Injection allowlist", injection.enabled && injectionAllowed ? "pass" : "fail",
    !injection.enabled ? "injection is disabled" : normalizedWorkspace && !injectionAllowed ? `${normalizedWorkspace} is not allowlisted` : `${injection.workspaces.length} workspace(s) allowlisted`));
  const captureAllowed = normalizedWorkspace
    ? isWorkspaceAllowed(captureConfig.workspaces, normalizedWorkspace)
    : captureConfig.workspaces.length > 0;
  checks.push(check("Capture allowlist", captureConfig.enabled && captureAllowed ? "pass" : "fail",
    !captureConfig.enabled ? "capture is disabled" : normalizedWorkspace && !captureAllowed ? `${normalizedWorkspace} is not allowlisted` : `${captureConfig.workspaces.length} workspace(s) allowlisted`));

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
  const transaction = new SetupTransaction("claude", ["preflight", "store", "mcp", "hooks", "config", "verify"]);
  const configBefore = structuredClone(config);
  const snapshots = [snapshotFile(configPath(env)), snapshotFile(claudeSettingsPath(env)), snapshotFile(hookManifestPath(env))];
  transaction.addRollback("restore_local_config_and_hooks", () => {
    for (const snapshot of [...snapshots].reverse()) restoreFile(snapshot);
    restoreObject(config, configBefore);
  });
  try {
    const workspace = normalizeWorkspacePath(input.workspace);
    const capabilities = await transaction.apply("preflight", () => {
      const result = probeClaude(env);
      if (!result.binary) throw new Error("Claude Code executable was not found in PATH");
      return result;
    }, (result) => result.version || result.binary || undefined);
    await transaction.apply("store", () => { new SqliteMemoryStore(config.databasePath).close(); }, () => "SQLite ready");

    const connectorBefore = connectorStatus("claude", config, env, { serverPath: paths.serverPath, nodePath: paths.nodePath });
    const managed = Boolean(config.connectedAgents.claude);
    const previousConnection = structuredClone(config.connectedAgents.claude);
    let mcp: { changed: boolean; binary?: string; backupPath?: string } = { changed: false };
    mcp = await transaction.apply("mcp", () => {
      if (connectorBefore.configured && managed) return mcp;
      if (connectorBefore.configured && !managed && !input.force) {
        throw new Error("An unmanaged open_continuity MCP entry already exists in Claude. Rerun with --force after reviewing it.");
      }
      return { changed: true, ...connectAgent("claude", config, paths.serverPath, env, Boolean(input.force || managed)) };
    }, (result) => result.changed ? "connected" : "already connected");
    if (mcp.changed) transaction.addRollback("restore_claude_mcp", () => rollbackAgentConnection("claude", config, previousConnection, env));

    const hooks = await transaction.apply("hooks", () => installClaudeHooks(env, paths.nodePath, paths), (result) => result.changed ? "installed or reconciled" : "already current");
    const adapter = config.adapters.claude;
    await transaction.apply("config", () => {
      adapter.injection = { enabled: true, workspaces: [...new Set([...adapter.injection.workspaces.map(normalizeWorkspacePath), workspace])] };
      adapter.capture = { enabled: true, workspaces: [...new Set([...adapter.capture.workspaces.map(normalizeWorkspacePath), workspace])] };
      saveConfig(config, env);
    }, () => "Claude permissions enabled");
    const doctor = await transaction.apply("verify", async () => {
      const result = await doctorClaudeAdapter(config, paths, env, workspace);
      if (!result.ok) throw new Error("Claude setup verification failed");
      return result;
    }, () => "doctor passed");
    transaction.verified("verify", "doctor passed");
    return {
      ok: true,
      operation: "setup_claude",
      adapter: "claude",
      workspace,
      steps: {
        captureCapability: { ok: true, mode: "Stop transcript hook", version: capabilities.version },
        mcp,
        injection: { enabled: true, hookChanged: hooks.changed, hookPath: paths.injectionHookPath },
        capture: { enabled: true, hookChanged: hooks.changed, hookPath: paths.captureHookPath, workspaces: adapter.capture.workspaces },
      },
      transaction: transaction.complete(),
      doctor,
    };
  } catch (error) {
    throw await transaction.rollbackAndWrap(error);
  }
}
