import { spawnSync } from "node:child_process";
import { adapterCaptureConfig, adapterInjectionConfig, configPath, isWorkspaceAllowed, normalizeWorkspacePath, saveConfig, type LocalConfig } from "./config.js";
import { connectAgent, connectorStatus, findExecutable, rollbackAgentConnection } from "./connectors.js";
import { runDoctor, type DoctorCheck } from "./doctor.js";
import { ConversationInbox } from "../capture/conversation-inbox.js";
import { captureDatabasePath } from "../capture/paths.js";
import { checkCodexHooks, installCodexHooks, type CodexHookPaths } from "../injection/codex-hook-config.js";
import { codexHooksPath } from "../capture/codex-app-server.js";
import { codexCaptureDoctor, captureCodexStatus } from "../capture/codex-capture-service.js";
import { SqliteMemoryStore } from "../sqlite/sqlite-memory-store.js";
import { isRegularHookFile } from "../injection/hook-health.js";
import { hookManifestPath } from "../injection/hook-manifest.js";
import { restoreFile, restoreObject, SetupTransaction, snapshotFile } from "./setup-transaction.js";

export interface CodexAdapterPaths extends CodexHookPaths { serverPath: string; nodePath: string; }

function check(name: string, status: DoctorCheck["status"], detail: string): DoctorCheck { return { name, status, detail }; }

function probeCodex(env: NodeJS.ProcessEnv): { binary: string | null; version: string | null; appServer: boolean } {
  const binary = findExecutable(["codex"], env);
  if (!binary) return { binary: null, version: null, appServer: false };
  const version = spawnSync(binary, ["--version"], { env, encoding: "utf8", timeout: 10_000 });
  const help = spawnSync(binary, ["app-server", "--help"], { env, encoding: "utf8", timeout: 10_000 });
  return { binary, version: [version.stdout, version.stderr].filter(Boolean).join(" ").trim() || null, appServer: help.status === 0 };
}

export async function doctorCodexAdapter(
  config: LocalConfig,
  paths: CodexAdapterPaths,
  env: NodeJS.ProcessEnv = process.env,
  workspace?: string,
): Promise<{ ok: boolean; adapter: "codex"; checks: DoctorCheck[]; manualActions: string[] }> {
  const checks: DoctorCheck[] = [];
  const injection = adapterInjectionConfig(config, "codex");
  const captureConfig = adapterCaptureConfig(config, "codex");
  const capabilities = probeCodex(env);
  checks.push(check("Codex installation", capabilities.binary ? "pass" : "fail", capabilities.version || capabilities.binary || "Codex executable not found"));
  checks.push(check("Codex app-server", capabilities.appServer ? "pass" : "fail", capabilities.appServer ? "app-server is available" : "Codex app-server is unavailable"));

  const connector = connectorStatus("codex", config, env, { serverPath: paths.serverPath, nodePath: paths.nodePath });
  const managed = Boolean(config.connectedAgents.codex);
  checks.push(check("Codex MCP connector", connector.configured && managed ? "pass" : "fail",
    connector.configured ? (managed ? "OpenContinuity MCP is configured and locally managed" : "an unmanaged OpenContinuity MCP entry already exists; rerun setup with --force") : connector.detail || "not configured"));

  const generic = await runDoctor(config, paths.serverPath, env);
  checks.push(...generic.checks.filter((entry) => ["MCP startup", "Tool discovery", "Capability probe", "Database read probe"].includes(entry.name))
    .map((entry) => ({ ...entry, name: `OpenContinuity ${entry.name}` })));

  const hooks = checkCodexHooks(env, paths.nodePath, paths);
  checks.push(check("Codex UserPromptSubmit hook", hooks.valid && hooks.injectionInstalled && isRegularHookFile(paths.injectionHookPath) ? "pass" : "fail",
    hooks.injectionInstalled ? (isRegularHookFile(paths.injectionHookPath) ? hooks.path : `hook entry exists but executable is missing: ${paths.injectionHookPath}`) : hooks.detail || "not installed"));
  checks.push(check("Codex Stop Capture hook", hooks.valid && hooks.captureInstalled && isRegularHookFile(paths.captureHookPath) ? "pass" : "fail",
    hooks.captureInstalled ? (isRegularHookFile(paths.captureHookPath) ? hooks.path : `hook entry exists but executable is missing: ${paths.captureHookPath}`) : hooks.detail || "not installed"));

  const normalizedWorkspace = workspace ? normalizeWorkspacePath(workspace) : undefined;
  const injectionAllowed = normalizedWorkspace ? isWorkspaceAllowed(injection.workspaces, normalizedWorkspace) : injection.workspaces.length > 0;
  checks.push(check("Injection allowlist", injection.enabled && injectionAllowed ? "pass" : "fail",
    !injection.enabled ? "injection is disabled" : normalizedWorkspace && !injectionAllowed ? `${normalizedWorkspace} is not allowlisted` : `${injection.workspaces.length} workspace(s) allowlisted`));
  const captureAllowed = normalizedWorkspace ? isWorkspaceAllowed(captureConfig.workspaces, normalizedWorkspace) : captureConfig.workspaces.length > 0;
  checks.push(check("Capture allowlist", captureConfig.enabled && captureAllowed ? "pass" : "fail",
    !captureConfig.enabled ? "capture is disabled" : normalizedWorkspace && !captureAllowed ? `${normalizedWorkspace} is not allowlisted` : `${captureConfig.workspaces.length} workspace(s) allowlisted`));

  const status = captureCodexStatus(env);
  const failures = Number(status.sync?.consecutive_failures ?? 0);
  checks.push(check("Codex Capture health", failures > 0 ? "fail" : status.sync?.last_success_at ? "pass" : "warn",
    failures > 0 ? `${failures} consecutive failure(s): ${String(status.sync?.last_warning || "unknown error")}` : status.sync?.last_success_at ? `last success: ${String(status.sync.last_success_at)}` : "Stop hook has not captured its first completed turn yet"));
  checks.push(check("Codex Capture checkpoints", status.checkpoints.threads > 0 ? "pass" : "warn",
    status.checkpoints.threads > 0 ? `${status.checkpoints.threads} session(s), ${status.checkpoints.trackedItems} item(s)` : "no durable Codex session checkpoint yet"));

  const manualActions = [
    "Restart active Codex sessions after setup so the user-level hooks are loaded.",
    "Open Codex /hooks once and trust the OpenContinuity UserPromptSubmit and Stop hooks before relying on automatic capture and injection.",
    "Keep normal MCP approval enabled, or approve OpenContinuity read tools when Codex requests deep memory search.",
  ];
  return { ok: checks.every((entry) => entry.status !== "fail"), adapter: "codex", checks, manualActions };
}

export async function setupCodexAdapter(
  config: LocalConfig,
  paths: CodexAdapterPaths,
  input: { workspace: string; force?: boolean },
  env: NodeJS.ProcessEnv = process.env,
) {
  const transaction = new SetupTransaction("codex", ["preflight", "store", "mcp", "hooks", "config", "verify"]);
  const configBefore = structuredClone(config);
  const snapshots = [snapshotFile(configPath(env)), snapshotFile(codexHooksPath(env)), snapshotFile(hookManifestPath(env))];
  transaction.addRollback("restore_local_config_and_hooks", () => {
    for (const snapshot of [...snapshots].reverse()) restoreFile(snapshot);
    restoreObject(config, configBefore);
  });
  try {
    const workspace = normalizeWorkspacePath(input.workspace);
    const capabilities = await transaction.apply("preflight", () => {
      const result = probeCodex(env);
      if (!result.binary) throw new Error("Codex executable was not found in PATH");
      if (!result.appServer) throw new Error("Codex app-server is unavailable in this installation");
      return result;
    }, (result) => result.version || result.binary || undefined);
    await transaction.apply("store", () => { new SqliteMemoryStore(config.databasePath).close(); }, () => "SQLite ready");

    const connectorBefore = connectorStatus("codex", config, env, { serverPath: paths.serverPath, nodePath: paths.nodePath });
    const managed = Boolean(config.connectedAgents.codex);
    const previousConnection = structuredClone(config.connectedAgents.codex);
    let mcp: { changed: boolean; binary?: string; backupPath?: string } = { changed: false };
    mcp = await transaction.apply("mcp", () => {
      if (connectorBefore.configured && managed) return mcp;
      if (connectorBefore.configured && !managed && !input.force) throw new Error("An unmanaged open_continuity MCP entry already exists in Codex. Rerun with --force after reviewing it.");
      return { changed: true, ...connectAgent("codex", config, paths.serverPath, env, Boolean(input.force || managed)) };
    }, (result) => result.changed ? "connected" : "already connected");
    if (mcp.changed) transaction.addRollback("restore_codex_mcp", () => rollbackAgentConnection("codex", config, previousConnection, env));

    const hooks = await transaction.apply("hooks", () => installCodexHooks(env, paths.nodePath, paths), (result) => result.changed ? "installed or reconciled" : "already current");
    const adapter = config.adapters.codex;
    await transaction.apply("config", () => {
      adapter.injection = { enabled: true, workspaces: [...new Set([...adapter.injection.workspaces.map(normalizeWorkspacePath), workspace])] };
      adapter.capture = { enabled: true, workspaces: [...new Set([...adapter.capture.workspaces.map(normalizeWorkspacePath), workspace])] };
      saveConfig(config, env);
    }, () => "Codex permissions enabled");
    const doctor = await transaction.apply("verify", async () => {
      const result = await doctorCodexAdapter(config, paths, env, workspace);
      if (!result.ok) throw new Error("Codex setup verification failed");
      return result;
    }, () => "doctor passed");
    transaction.verified("verify", "doctor passed");
    return {
      ok: true, operation: "setup_codex", adapter: "codex", workspace,
      steps: {
        captureCapability: { ok: true, mode: "Stop hook + app-server", version: capabilities.version },
        mcp, injection: { enabled: true, hookChanged: hooks.changed, hookPath: paths.injectionHookPath },
        capture: { enabled: true, hookChanged: hooks.changed, hookPath: paths.captureHookPath, workspaces: adapter.capture.workspaces },
      }, transaction: transaction.complete(), doctor,
    };
  } catch (error) {
    throw await transaction.rollbackAndWrap(error);
  }
}
