import { adapterCaptureConfig, adapterInjectionConfig, configPath, isWorkspaceAllowed, normalizeWorkspacePath, saveConfig, type LocalConfig } from "./config.js";
import { connectAgent, connectorStatus, rollbackAgentConnection } from "./connectors.js";
import { runDoctor, type DoctorCheck } from "./doctor.js";
import { captureLockStatus } from "../capture/capture-lock.js";
import { captureServicePaths, captureServiceSupported, installCaptureService, startCaptureService, statusCaptureService, stopCaptureService } from "../capture/capture-service.js";
import { captureDoctor, captureStatus } from "../capture/trae-capture-service.js";
import { TraeInjectionAdapter, traeHookConfigPath } from "../injection/trae-hook-config.js";
import { isRegularHookFile } from "../injection/hook-health.js";
import { SqliteMemoryStore } from "../sqlite/sqlite-memory-store.js";
import { hookManifestPath } from "../injection/hook-manifest.js";
import { restoreFile, restoreObject, SetupTransaction, snapshotFile } from "./setup-transaction.js";

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
  const injection = adapterInjectionConfig(config, "trae");
  const captureConfig = adapterCaptureConfig(config, "trae");
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
  checks.push(check("Trae UserPromptSubmit hook", hook.valid && hook.installed && isRegularHookFile(paths.injectionHookPath) ? "pass" : "fail",
    hook.valid && hook.installed ? (isRegularHookFile(paths.injectionHookPath) ? hook.path : `hook entry exists but executable is missing: ${paths.injectionHookPath}`) : hook.detail || "not installed"));

  const normalizedWorkspace = workspace ? normalizeWorkspacePath(workspace) : undefined;
  const workspaceAllowed = normalizedWorkspace
    ? isWorkspaceAllowed(injection.workspaces, normalizedWorkspace)
    : injection.workspaces.length > 0;
  checks.push(check("Injection allowlist", injection.enabled && workspaceAllowed ? "pass" : "fail",
    !injection.enabled ? "injection is disabled" : normalizedWorkspace && !workspaceAllowed ? `${normalizedWorkspace} is not allowlisted` : `${injection.workspaces.length} workspace(s) allowlisted`));

  const captureWorkspaceAllowed = normalizedWorkspace
    ? isWorkspaceAllowed(captureConfig.workspaces, normalizedWorkspace)
    : captureConfig.workspaces.length > 0;
  checks.push(check("Capture allowlist", captureConfig.enabled && captureWorkspaceAllowed ? "pass" : "fail",
    !captureConfig.enabled ? "capture is disabled" : normalizedWorkspace && !captureWorkspaceAllowed ? `${normalizedWorkspace} is not allowlisted` : `${captureConfig.workspaces.length} workspace(s) allowlisted`));

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
  const transaction = new SetupTransaction("trae", ["preflight", "store", "mcp", "hooks", "config", "service", "verify"]);
  const configBefore = structuredClone(config);
  const localSnapshots = [snapshotFile(configPath(env)), snapshotFile(traeHookConfigPath(env)), snapshotFile(hookManifestPath(env))];
  transaction.addRollback("restore_local_config_and_hooks", () => {
    for (const snapshot of [...localSnapshots].reverse()) restoreFile(snapshot);
    restoreObject(config, configBefore);
  });
  try {
    const workspace = normalizeWorkspacePath(input.workspace);
    const capabilities = await transaction.apply("preflight", () => {
      const result = captureDoctor(env);
      if (!result.ok) throw new Error(`Trae Capture Adapter is unavailable: ${result.readiness}`);
      return result;
    }, (result) => result.capabilities.version || result.readiness);
    await transaction.apply("store", () => { new SqliteMemoryStore(config.databasePath).close(); }, () => "SQLite ready");

    const connectorBefore = connectorStatus("trae", config, env, { serverPath: paths.serverPath, nodePath: paths.nodePath });
    const managed = Boolean(config.connectedAgents.trae);
    const previousConnection = structuredClone(config.connectedAgents.trae);
    let mcp: { changed: boolean; binary?: string; backupPath?: string } = { changed: false };
    mcp = await transaction.apply("mcp", () => {
      if (connectorBefore.configured && managed) return mcp;
      if (connectorBefore.configured && !managed && !input.force) {
        throw new Error("An unmanaged open_continuity MCP entry already exists in Trae. Rerun with --force after reviewing it.");
      }
      return { changed: true, ...connectAgent("trae", config, paths.serverPath, env, Boolean(input.force || managed)) };
    }, (result) => result.changed ? "connected" : "already connected");
    if (mcp.changed) transaction.addRollback("restore_trae_mcp", () => rollbackAgentConnection("trae", config, previousConnection, env));

    const injectionAdapter = new TraeInjectionAdapter(env, paths.nodePath, paths.injectionHookPath);
    const hook = await transaction.apply("hooks", () => injectionAdapter.install(), (result) => result.changed ? "installed or reconciled" : "already current");
    const adapter = config.adapters.trae;
    await transaction.apply("config", () => {
      adapter.injection = { enabled: true, workspaces: [...new Set([...adapter.injection.workspaces.map(normalizeWorkspacePath), workspace])] };
      adapter.capture = { enabled: true, workspaces: [...new Set([...adapter.capture.workspaces.map(normalizeWorkspacePath), workspace])] };
      saveConfig(config, env);
    }, () => "Trae permissions enabled");

    const serviceAvailable = captureServiceSupported(env);
    const serviceSnapshot = snapshotFile(captureServicePaths(env).plistPath);
    const serviceBefore = serviceAvailable ? statusCaptureService(env) : null;
    let serviceTouched = false;
    transaction.addRollback("restore_capture_service", () => {
      if (!serviceTouched || !serviceBefore) return;
      stopCaptureService(env);
      restoreFile(serviceSnapshot);
      if (serviceBefore.running) startCaptureService(env);
    });
    const captureService = await transaction.apply("service", () => {
      if (!serviceAvailable) return { supported: false, installed: false, status: "manual_watch_required" };
      serviceTouched = true;
      const installedService = installCaptureService({
        nodePath: paths.nodePath, cliPath: paths.cliPath,
        config: { intervalMs: config.capture.intervalMs, pageSize: config.capture.pageSize, maxThreads: config.capture.maxThreads, retryLimit: config.capture.retryLimit },
      }, env);
      if (serviceBefore!.running && installedService.changed) stopCaptureService(env);
      const startedService = startCaptureService(env);
      return { supported: true, installed: installedService.installed, configChanged: installedService.changed, reloaded: serviceBefore!.running && installedService.changed, status: startedService.status, alreadyRunning: startedService.alreadyRunning };
    }, (result) => result.supported ? String(result.status) : "manual watch required");
    const doctor = await transaction.apply("verify", async () => {
      const result = await doctorTraeAdapter(config, paths, env, workspace);
      if (!result.ok) throw new Error("Trae setup verification failed");
      return result;
    }, () => "doctor passed");
    transaction.verified("verify", "doctor passed");
    return {
      ok: true, operation: "setup_trae", adapter: "trae", workspace,
      steps: {
        captureCapability: { ok: true, version: capabilities.capabilities.version },
        mcp,
        injection: { enabled: true, hookChanged: hook.changed, hookPath: hook.path },
        capture: { enabled: true, workspaces: adapter.capture.workspaces },
        captureService,
      },
      transaction: transaction.complete(),
      doctor,
    };
  } catch (error) {
    throw await transaction.rollbackAndWrap(error);
  }
}
