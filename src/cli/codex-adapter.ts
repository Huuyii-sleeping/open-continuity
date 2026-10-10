import { existsSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { isWorkspaceAllowed, normalizeWorkspacePath, saveConfig, type LocalConfig } from "./config.js";
import { connectAgent, connectorStatus, findExecutable } from "./connectors.js";
import { runDoctor, type DoctorCheck } from "./doctor.js";
import { ConversationInbox } from "../capture/conversation-inbox.js";
import { captureDatabasePath } from "../capture/paths.js";
import { checkCodexHooks, installCodexHooks, type CodexHookPaths } from "../injection/codex-hook-config.js";
import { codexCaptureDoctor, captureCodexStatus } from "../capture/codex-capture-service.js";
import { SqliteMemoryStore } from "../sqlite/sqlite-memory-store.js";

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
  checks.push(check("Codex UserPromptSubmit hook", hooks.valid && hooks.injectionInstalled && existsSync(paths.injectionHookPath) ? "pass" : "fail",
    hooks.injectionInstalled ? (existsSync(paths.injectionHookPath) ? hooks.path : `hook entry exists but executable is missing: ${paths.injectionHookPath}`) : hooks.detail || "not installed"));
  checks.push(check("Codex Stop Capture hook", hooks.valid && hooks.captureInstalled && existsSync(paths.captureHookPath) ? "pass" : "fail",
    hooks.captureInstalled ? (existsSync(paths.captureHookPath) ? hooks.path : `hook entry exists but executable is missing: ${paths.captureHookPath}`) : hooks.detail || "not installed"));

  const normalizedWorkspace = workspace ? normalizeWorkspacePath(workspace) : undefined;
  const injectionAllowed = normalizedWorkspace ? isWorkspaceAllowed(config.injection.workspaces, normalizedWorkspace) : config.injection.workspaces.length > 0;
  checks.push(check("Injection allowlist", config.injection.enabled && injectionAllowed ? "pass" : "fail",
    !config.injection.enabled ? "injection is disabled" : normalizedWorkspace && !injectionAllowed ? `${normalizedWorkspace} is not allowlisted` : `${config.injection.workspaces.length} workspace(s) allowlisted`));
  const captureAllowed = normalizedWorkspace ? isWorkspaceAllowed(config.capture.workspaces, normalizedWorkspace) : config.capture.workspaces.length > 0;
  checks.push(check("Capture allowlist", config.capture.enabled && captureAllowed ? "pass" : "fail",
    !config.capture.enabled ? "capture is disabled" : normalizedWorkspace && !captureAllowed ? `${normalizedWorkspace} is not allowlisted` : `${config.capture.workspaces.length} workspace(s) allowlisted`));

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
  const workspace = normalizeWorkspacePath(input.workspace);
  const capabilities = probeCodex(env);
  if (!capabilities.binary) throw new Error("Codex executable was not found in PATH");
  if (!capabilities.appServer) throw new Error("Codex app-server is unavailable in this installation");
  new SqliteMemoryStore(config.databasePath).close();

  const before = connectorStatus("codex", config, env, { serverPath: paths.serverPath, nodePath: paths.nodePath });
  const managed = Boolean(config.connectedAgents.codex);
  let mcp: { changed: boolean; binary?: string; backupPath?: string } = { changed: false };
  if (!before.configured || !managed) {
    if (before.configured && !managed && !input.force) throw new Error("An unmanaged open_continuity MCP entry already exists in Codex. Rerun with --force after reviewing it.");
    mcp = { changed: true, ...connectAgent("codex", config, paths.serverPath, env, Boolean(input.force || managed)) };
  }

  const hooks = installCodexHooks(env, paths.nodePath, paths);
  config.injection = { ...config.injection, enabled: true, workspaces: [...new Set([...config.injection.workspaces.map(normalizeWorkspacePath), workspace])] };
  config.capture = { ...config.capture, enabled: true, workspaces: [...new Set([...config.capture.workspaces.map(normalizeWorkspacePath), workspace])] };
  saveConfig(config, env);
  const doctor = await doctorCodexAdapter(config, paths, env, workspace);
  return {
    ok: doctor.ok, operation: "setup_codex", adapter: "codex", workspace,
    steps: {
      captureCapability: { ok: true, mode: "Stop hook + app-server", version: capabilities.version },
      mcp, injection: { enabled: true, hookChanged: hooks.changed, hookPath: paths.injectionHookPath },
      capture: { enabled: true, hookChanged: hooks.changed, hookPath: paths.captureHookPath, workspaces: config.capture.workspaces },
    }, doctor,
  };
}
