import { existsSync } from "node:fs";
import { isWorkspaceAllowed, normalizeWorkspacePath, saveConfig, type LocalConfig } from "./config.js";
import { connectAgent, connectorStatus } from "./connectors.js";
import { runDoctor, type DoctorCheck } from "./doctor.js";
import { captureLockStatus } from "../capture/capture-lock.js";
import { captureServiceSupported, installCaptureService, startCaptureService, statusCaptureService, stopCaptureService } from "../capture/capture-service.js";
import { captureDoctor, captureStatus } from "../capture/trae-capture-service.js";
import { TraeInjectionAdapter } from "../injection/trae-hook-config.js";
import { SqliteMemoryStore } from "../sqlite/sqlite-memory-store.js";

export interface TraeAdapterPaths {
  cliPath: string;
  serverPath: string;
  injectionHookPath: string;
  nodePath: string;
}

function check(name: string, status: DoctorCheck["status"], detail: string): DoctorCheck {
  return { name, status, detail };
}

export async function doctorTraeAdapter(
  config: LocalConfig,
  paths: TraeAdapterPaths,
  env: NodeJS.ProcessEnv = process.env,
  workspace?: string,
): Promise<{ ok: boolean; adapter: "trae"; checks: DoctorCheck[]; manualActions: string[] }> {
  const checks: DoctorCheck[] = [];
  const capabilities = captureDoctor(env);
  checks.push(check("Trae installation", capabilities.capabilities.available ? "pass" : "fail", capabilities.capabilities.version || capabilities.readiness));
  checks.push(check("Trae Capture API", capabilities.capabilities.appServer ? "pass" : "fail", capabilities.capabilities.appServer ? "app-server is available" : capabilities.readiness));

  const connector = connectorStatus("trae", config, env, { serverPath: paths.serverPath, nodePath: paths.nodePath });
  const managed = Boolean(config.connectedAgents.trae);
  checks.push(check("Trae MCP connector", connector.configured && managed ? "pass" : "fail",
    connector.configured ? (managed ? "OpenContinuity MCP is configured and locally managed" : "an unmanaged OpenContinuity MCP entry already exists; rerun setup with --force") : connector.detail || "not configured"));

  const generic = await runDoctor(config, paths.serverPath, env);
  checks.push(...generic.checks.filter((entry) => ["MCP startup", "Tool discovery", "Capability probe", "Database read probe"].includes(entry.name))
    .map((entry) => ({ ...entry, name: `OpenContinuity ${entry.name}` })));

  const injectionAdapter = new TraeInjectionAdapter(env, paths.nodePath, paths.injectionHookPath);
  const hook = injectionAdapter.check();
  checks.push(check("Trae UserPromptSubmit hook", hook.valid && hook.installed && existsSync(paths.injectionHookPath) ? "pass" : "fail",
    hook.valid && hook.installed ? (existsSync(paths.injectionHookPath) ? hook.path : `hook entry exists but executable is missing: ${paths.injectionHookPath}`) : hook.detail || "not installed"));

  const normalizedWorkspace = workspace ? normalizeWorkspacePath(workspace) : undefined;
  const workspaceAllowed = normalizedWorkspace
    ? isWorkspaceAllowed(config.injection.workspaces, normalizedWorkspace)
    : config.injection.workspaces.length > 0;
  checks.push(check("Injection allowlist", config.injection.enabled && workspaceAllowed ? "pass" : "fail",
    !config.injection.enabled ? "injection is disabled" : normalizedWorkspace && !workspaceAllowed ? `${normalizedWorkspace} is not allowlisted` : `${config.injection.workspaces.length} workspace(s) allowlisted`));

  const captureWorkspaceAllowed = normalizedWorkspace
    ? isWorkspaceAllowed(config.capture.workspaces, normalizedWorkspace)
    : config.capture.workspaces.length > 0;
  checks.push(check("Capture allowlist", config.capture.enabled && captureWorkspaceAllowed ? "pass" : "fail",
    !config.capture.enabled ? "capture is disabled" : normalizedWorkspace && !captureWorkspaceAllowed ? `${normalizedWorkspace} is not allowlisted` : `${config.capture.workspaces.length} workspace(s) allowlisted`));

  const serviceSupported = captureServiceSupported(env);
  const service = statusCaptureService(env);
  checks.push(check("Capture background service", !serviceSupported ? "warn" : service.installed && service.running ? "pass" : "fail",
    !serviceSupported ? "launchd is unavailable; run capture watch under a local process manager" : !service.installed ? "launchd service is not installed" : service.running ? "installed and running" : "installed but not running"));
  const capture = captureStatus(env);
  const failures = Number(capture.sync?.consecutive_failures ?? 0);
  checks.push(check("Capture health", failures > 0 ? "fail" : capture.sync?.last_success_at ? "pass" : "warn",
    failures > 0 ? `${failures} consecutive failure(s): ${String(capture.sync?.last_warning || "unknown error")}` : capture.sync?.last_success_at ? `last success: ${String(capture.sync.last_success_at)}` : "service has not completed its first sync yet"));
  checks.push(check("Capture checkpoints", capture.checkpoints.threads > 0 ? "pass" : "warn",
    capture.checkpoints.threads > 0 ? `${capture.checkpoints.threads} thread(s), ${capture.checkpoints.trackedItems} item(s)` : "no durable thread checkpoint yet"));
  const lock = captureLockStatus(env);
  checks.push(check("Capture worker lock", lock.locked ? "pass" : service.running || !serviceSupported ? "warn" : "fail", lock.locked ? `worker pid ${lock.pid ?? "unknown"}` : "worker lock is not currently held"));

  checks.push(check("Trae Hook trust", "warn", "Trae does not expose non-interactive trust state; verify this UserPromptSubmit hook once in /hooks"));
  checks.push(check("Trae MCP tool approval", "warn", "tool approval is controlled by Trae; setup does not enable a global permission bypass"));
  const manualActions = [
    "Open Trae /hooks once and trust the OpenContinuity UserPromptSubmit hook if Trae marks it untrusted.",
    "Keep normal MCP approval enabled, or approve OpenContinuity read tools when Trae requests deep memory search.",
    ...(!serviceSupported ? ["Run `open-continuity capture watch` with a local process manager because launchd is unavailable."] : []),
  ];
  return { ok: checks.every((entry) => entry.status !== "fail"), adapter: "trae", checks, manualActions };
}

export async function setupTraeAdapter(
  config: LocalConfig,
  paths: TraeAdapterPaths,
  input: { workspace: string; force?: boolean },
  env: NodeJS.ProcessEnv = process.env,
) {
  const workspace = normalizeWorkspacePath(input.workspace);
  const capabilities = captureDoctor(env);
  if (!capabilities.ok) throw new Error(`Trae Capture Adapter is unavailable: ${capabilities.readiness}`);
  new SqliteMemoryStore(config.databasePath).close();

  const before = connectorStatus("trae", config, env, { serverPath: paths.serverPath, nodePath: paths.nodePath });
  const managed = Boolean(config.connectedAgents.trae);
  let mcp: { changed: boolean; binary?: string; backupPath?: string } = { changed: false };
  if (!before.configured || !managed) {
    if (before.configured && !managed && !input.force) {
      throw new Error("An unmanaged open_continuity MCP entry already exists in Trae. Rerun with --force after reviewing it.");
    }
    mcp = { changed: true, ...connectAgent("trae", config, paths.serverPath, env, Boolean(input.force || managed)) };
  }

  const injectionAdapter = new TraeInjectionAdapter(env, paths.nodePath, paths.injectionHookPath);
  const hook = injectionAdapter.install();
  config.injection = { ...config.injection, enabled: true, workspaces: [...new Set([...config.injection.workspaces.map(normalizeWorkspacePath), workspace])] };
  config.capture = { ...config.capture, enabled: true, workspaces: [...new Set([...config.capture.workspaces.map(normalizeWorkspacePath), workspace])] };
  saveConfig(config, env);
  const serviceAvailable = captureServiceSupported(env);
  let captureService: Record<string, unknown>;
  if (serviceAvailable) {
    const serviceBefore = statusCaptureService(env);
    const installedService = installCaptureService({
      nodePath: paths.nodePath, cliPath: paths.cliPath,
      config: { intervalMs: config.capture.intervalMs, pageSize: config.capture.pageSize, maxThreads: config.capture.maxThreads, retryLimit: config.capture.retryLimit },
    }, env);
    if (serviceBefore.running && installedService.changed) stopCaptureService(env);
    const startedService = startCaptureService(env);
    captureService = { supported: true, installed: installedService.installed, configChanged: installedService.changed, reloaded: serviceBefore.running && installedService.changed, status: startedService.status, alreadyRunning: startedService.alreadyRunning };
  } else {
    captureService = { supported: false, installed: false, status: "manual_watch_required" };
  }
  const doctor = await doctorTraeAdapter(config, paths, env, workspace);
  return {
    ok: doctor.ok, operation: "setup_trae", adapter: "trae", workspace,
    steps: {
      captureCapability: { ok: true, version: capabilities.capabilities.version },
      mcp,
      injection: { enabled: true, hookChanged: hook.changed, hookPath: hook.path },
      capture: { enabled: true, workspaces: config.capture.workspaces },
      captureService,
    },
    doctor,
  };
}
