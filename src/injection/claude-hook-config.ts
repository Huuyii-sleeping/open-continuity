import { chmodSync, copyFileSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";
import { continuityHome } from "../cli/config.js";
import type { InjectionAdapter, InjectionAdapterInstallResult, InjectionAdapterStatus, InjectionAdapterUninstallResult } from "../adapters/contracts.js";
import type { InjectionHookOutput } from "./types.js";
import { renderMemoryContext } from "./context-envelope.js";
import { clearManagedHooks, managedHooks, recordManagedHooks, type ManagedHook } from "./hook-manifest.js";

interface HookHandler {
  type?: unknown;
  command?: unknown;
  args?: unknown;
  [key: string]: unknown;
}

interface HookGroup {
  hooks?: unknown;
  [key: string]: unknown;
}

interface ClaudeSettings {
  hooks?: Record<string, unknown>;
  [key: string]: unknown;
}

export interface ClaudeHookPaths {
  injectionHookPath: string;
  captureHookPath: string;
}

export interface ClaudeHookStatus extends InjectionAdapterStatus {
  path: string;
  exists: boolean;
  injectionInstalled: boolean;
  captureInstalled: boolean;
  injectionCommand: { command: string; args: string[] };
  captureCommand: { command: string; args: string[] };
}

export interface ClaudeHookInstallResult extends ClaudeHookStatus {
  changed: boolean;
  backupPath?: string;
}

export function claudeSettingsPath(env: NodeJS.ProcessEnv = process.env): string {
  const directory = env.CLAUDE_CONFIG_DIR || join(env.HOME || homedir(), ".claude");
  return join(directory, "settings.json");
}

function readSettings(path: string): ClaudeSettings {
  if (!existsSync(path)) return { hooks: {} };
  const parsed = JSON.parse(readFileSync(path, "utf8")) as ClaudeSettings;
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error(`Invalid Claude settings: ${path}`);
  if (parsed.hooks != null && (typeof parsed.hooks !== "object" || Array.isArray(parsed.hooks))) {
    throw new Error(`Invalid Claude hooks config: ${path}`);
  }
  return parsed;
}

function hookGroups(settings: ClaudeSettings, event: "UserPromptSubmit" | "Stop"): HookGroup[] {
  const value = settings.hooks?.[event];
  if (value == null) return [];
  if (!Array.isArray(value)) throw new Error(`Invalid Claude ${event} hook config`);
  for (const group of value) {
    if (!group || typeof group !== "object" || Array.isArray(group) || !Array.isArray((group as HookGroup).hooks)) {
      throw new Error(`Invalid Claude ${event} hook group`);
    }
  }
  return value as HookGroup[];
}

function matchesHandler(handler: unknown, command: string, args: string[]): boolean {
  if (!handler || typeof handler !== "object") return false;
  const candidate = handler as HookHandler;
  return candidate.type === "command" && candidate.command === command && Array.isArray(candidate.args)
    && candidate.args.length === args.length && candidate.args.every((entry, index) => entry === args[index]);
}

const CLAUDE_INJECTION_STATUS = "loading user-approved OpenContinuity memory";
const CLAUDE_CAPTURE_STATUS = "capturing the completed turn for OpenContinuity review";

function managedIdentity(hook: ManagedHook): string {
  return JSON.stringify([hook.command, hook.args ?? []]);
}

function handlerIdentity(handler: HookHandler): string | null {
  return handler.type === "command" && typeof handler.command === "string" && Array.isArray(handler.args)
    ? JSON.stringify([handler.command, handler.args])
    : null;
}

function isManagedHandler(handler: unknown, identities: Set<string>, statusMessage: string): boolean {
  if (!handler || typeof handler !== "object") return false;
  const value = handler as HookHandler;
  const identity = handlerIdentity(value);
  return (identity != null && identities.has(identity)) || (value.type === "command" && value.statusMessage === statusMessage);
}

function removeManagedHandlers(groups: HookGroup[], identities: Set<string>, statusMessage: string): { groups: HookGroup[]; removed: number } {
  let removed = 0;
  const retained = groups.flatMap((group) => {
    if (!Array.isArray(group.hooks)) return [group];
    const hooks = group.hooks.filter((handler) => {
      const owned = isManagedHandler(handler, identities, statusMessage);
      if (owned) removed += 1;
      return !owned;
    });
    return hooks.length > 0 ? [{ ...group, hooks }] : [];
  });
  return { groups: retained, removed };
}

function eventHasHandler(settings: ClaudeSettings, event: "UserPromptSubmit" | "Stop", command: string, args: string[]): boolean {
  return hookGroups(settings, event).some((group) => Array.isArray(group.hooks)
    && (group.hooks as unknown[]).some((handler) => matchesHandler(handler, command, args)));
}

function writeJsonAtomic(path: string, settings: ClaudeSettings): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.${process.pid}.tmp`;
  writeFileSync(temporary, JSON.stringify(settings, null, 2) + "\n", { encoding: "utf8", mode: 0o600 });
  renameSync(temporary, path);
}

function backupSettings(env: NodeJS.ProcessEnv, path: string): string {
  const directory = join(continuityHome(env), "backups");
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const backup = join(directory, `claude-hooks-${new Date().toISOString().replaceAll(":", "-")}-${basename(path)}`);
  copyFileSync(path, backup);
  chmodSync(backup, 0o600);
  return backup;
}

export function checkClaudeHooks(
  env: NodeJS.ProcessEnv = process.env,
  nodePath = process.execPath,
  paths: ClaudeHookPaths,
): ClaudeHookStatus {
  const path = claudeSettingsPath(env);
  const injectionArgs = [paths.injectionHookPath];
  const captureArgs = [paths.captureHookPath];
  if (!existsSync(path)) {
    return {
      path, exists: false, valid: true, installed: false, injectionInstalled: false, captureInstalled: false,
      injectionCommand: { command: nodePath, args: injectionArgs }, captureCommand: { command: nodePath, args: captureArgs },
      detail: "settings.json does not exist",
    };
  }
  try {
    const settings = readSettings(path);
    const injectionInstalled = eventHasHandler(settings, "UserPromptSubmit", nodePath, injectionArgs);
    const captureInstalled = eventHasHandler(settings, "Stop", nodePath, captureArgs);
    return {
      path, exists: true, valid: true, installed: injectionInstalled && captureInstalled, injectionInstalled, captureInstalled,
      injectionCommand: { command: nodePath, args: injectionArgs }, captureCommand: { command: nodePath, args: captureArgs },
      ...(!injectionInstalled || !captureInstalled ? { detail: "OpenContinuity Claude hooks are not fully installed" } : {}),
    };
  } catch (error) {
    return {
      path, exists: true, valid: false, installed: false, injectionInstalled: false, captureInstalled: false,
      injectionCommand: { command: nodePath, args: injectionArgs }, captureCommand: { command: nodePath, args: captureArgs },
      detail: error instanceof Error ? error.message : String(error),
    };
  }
}

export function installClaudeHooks(
  env: NodeJS.ProcessEnv = process.env,
  nodePath = process.execPath,
  paths: ClaudeHookPaths,
): ClaudeHookInstallResult {
  if (!paths.injectionHookPath || !paths.captureHookPath) throw new Error("Claude Adapter requires both hook executable paths");
  const before = checkClaudeHooks(env, nodePath, paths);
  if (!before.valid) throw new Error(before.detail || "Invalid Claude hooks config");
  const path = before.path;
  const settings = readSettings(path);
  const hooks = settings.hooks ?? (settings.hooks = {});
  const injectionGroups = hookGroups(settings, "UserPromptSubmit");
  const captureGroups = hookGroups(settings, "Stop");
  const previous = managedHooks("claude", env);
  const injectionIdentities = new Set(previous.filter((hook) => hook.event === "UserPromptSubmit").map(managedIdentity));
  const captureIdentities = new Set(previous.filter((hook) => hook.event === "Stop").map(managedIdentity));
  const currentInjection = JSON.stringify([nodePath, [paths.injectionHookPath]]);
  const currentCapture = JSON.stringify([nodePath, [paths.captureHookPath]]);
  const staleInjection = injectionGroups.some((group) => Array.isArray(group.hooks) && group.hooks.some((handler) => isManagedHandler(handler, injectionIdentities, CLAUDE_INJECTION_STATUS) && handlerIdentity(handler as HookHandler) !== currentInjection));
  const staleCapture = captureGroups.some((group) => Array.isArray(group.hooks) && group.hooks.some((handler) => isManagedHandler(handler, captureIdentities, CLAUDE_CAPTURE_STATUS) && handlerIdentity(handler as HookHandler) !== currentCapture));
  const desired = [
    { event: "UserPromptSubmit" as const, command: nodePath, args: [paths.injectionHookPath] },
    { event: "Stop" as const, command: nodePath, args: [paths.captureHookPath] },
  ];
  if (before.installed && !staleInjection && !staleCapture) {
    recordManagedHooks("claude", path, desired, env);
    return { ...before, changed: false };
  }

  const reconciledInjection = removeManagedHandlers(injectionGroups, injectionIdentities, CLAUDE_INJECTION_STATUS).groups;
  const reconciledCapture = removeManagedHandlers(captureGroups, captureIdentities, CLAUDE_CAPTURE_STATUS).groups;
  reconciledInjection.push({ hooks: [{
    type: "command", command: nodePath, args: [paths.injectionHookPath], timeout: 1,
    statusMessage: CLAUDE_INJECTION_STATUS,
  }] });
  reconciledCapture.push({ hooks: [{
    type: "command", command: nodePath, args: [paths.captureHookPath], timeout: 10,
    statusMessage: CLAUDE_CAPTURE_STATUS,
  }] });
  hooks.UserPromptSubmit = reconciledInjection;
  hooks.Stop = reconciledCapture;
  const backupPath = existsSync(path) ? backupSettings(env, path) : undefined;
  writeJsonAtomic(path, settings);
  recordManagedHooks("claude", path, desired, env);
  return { ...checkClaudeHooks(env, nodePath, paths), changed: true, ...(backupPath ? { backupPath } : {}) };
}

export function uninstallClaudeHooks(
  env: NodeJS.ProcessEnv = process.env,
  nodePath = process.execPath,
  paths: ClaudeHookPaths,
): ClaudeHookInstallResult {
  const path = claudeSettingsPath(env);
  if (!existsSync(path)) {
    clearManagedHooks("claude", env);
    return { ...checkClaudeHooks(env, nodePath, paths), changed: false };
  }
  const settings = readSettings(path);
  const hooks = settings.hooks ?? (settings.hooks = {});
  const previous = managedHooks("claude", env);
  const injectionIdentities = new Set([
    JSON.stringify([nodePath, [paths.injectionHookPath]]),
    ...previous.filter((hook) => hook.event === "UserPromptSubmit").map(managedIdentity),
  ]);
  const captureIdentities = new Set([
    JSON.stringify([nodePath, [paths.captureHookPath]]),
    ...previous.filter((hook) => hook.event === "Stop").map(managedIdentity),
  ]);
  const injection = removeManagedHandlers(hookGroups(settings, "UserPromptSubmit"), injectionIdentities, CLAUDE_INJECTION_STATUS);
  const capture = removeManagedHandlers(hookGroups(settings, "Stop"), captureIdentities, CLAUDE_CAPTURE_STATUS);
  const removed = injection.removed + capture.removed;
  if (removed === 0) {
    clearManagedHooks("claude", env);
    return { ...checkClaudeHooks(env, nodePath, paths), injectionInstalled: false, captureInstalled: false, installed: false, changed: false };
  }
  if (injection.groups.length > 0) hooks.UserPromptSubmit = injection.groups;
  else delete hooks.UserPromptSubmit;
  if (capture.groups.length > 0) hooks.Stop = capture.groups;
  else delete hooks.Stop;
  const backupPath = backupSettings(env, path);
  writeJsonAtomic(path, settings);
  clearManagedHooks("claude", env);
  return { ...checkClaudeHooks(env, nodePath, paths), injectionInstalled: false, captureInstalled: false, installed: false, changed: true, backupPath };
}

export class ClaudeInjectionAdapter implements InjectionAdapter<InjectionHookOutput> {
  readonly id = "claude";
  readonly hookEvent = "UserPromptSubmit";

  constructor(
    private readonly env: NodeJS.ProcessEnv = process.env,
    private readonly nodePath = process.execPath,
    private readonly paths: ClaudeHookPaths = { injectionHookPath: "", captureHookPath: "" },
  ) {}

  emptyOutput(): InjectionHookOutput {
    return { continue: true, suppressOutput: true };
  }

  renderContext(context: string): InjectionHookOutput {
    if (!context) return this.emptyOutput();
    return {
      continue: true,
      suppressOutput: true,
      hookSpecificOutput: {
        hookEventName: "UserPromptSubmit",
        additionalContext: renderMemoryContext(context),
      },
    };
  }

  check(): InjectionAdapterStatus {
    const status = checkClaudeHooks(this.env, this.nodePath, this.paths);
    return { valid: status.valid, installed: status.injectionInstalled, detail: status.detail };
  }

  install(): InjectionAdapterInstallResult {
    const result = installClaudeHooks(this.env, this.nodePath, this.paths);
    return { valid: result.valid, installed: result.injectionInstalled, changed: result.changed, detail: result.detail };
  }

  uninstall(): InjectionAdapterUninstallResult {
    const result = uninstallClaudeHooks(this.env, this.nodePath, this.paths);
    return { valid: result.valid, installed: result.injectionInstalled, changed: result.changed, detail: result.detail };
  }
}
