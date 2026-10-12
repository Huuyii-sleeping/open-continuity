import { copyFileSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { continuityHome } from "../cli/config.js";
import type { InjectionAdapter } from "../adapters/contracts.js";
import type { InjectionHookOutput } from "./types.js";
import { renderMemoryContext } from "./context-envelope.js";
import { clearManagedHooks, managedHooks, recordManagedHooks } from "./hook-manifest.js";

interface HookHandler { type?: unknown; command?: unknown; [key: string]: unknown; }
interface HookGroup { matcher?: unknown; hooks?: unknown; [key: string]: unknown; }
interface HooksDocument { hooks?: Record<string, unknown>; [key: string]: unknown; }

function hookHome(env: NodeJS.ProcessEnv): string {
  return env.TRAECLI_HOME || (env.TRAE_HOME ? join(env.TRAE_HOME, "cli") : join(env.HOME || "", ".trae", "cli"));
}

export function traeHookConfigPath(env: NodeJS.ProcessEnv = process.env): string { return join(hookHome(env), "hooks.json"); }

function shellQuote(value: string): string { return `'${value.replaceAll("'", "'\"'\"'")}'`; }

export function injectionHookCommand(nodePath: string, hookPath: string): string { return `${shellQuote(nodePath)} ${shellQuote(hookPath)}`; }

function readHooks(path: string): HooksDocument {
  if (!existsSync(path)) return { hooks: {} };
  const parsed = JSON.parse(readFileSync(path, "utf8")) as HooksDocument;
  if (!parsed || typeof parsed !== "object" || !parsed.hooks || typeof parsed.hooks !== "object" || Array.isArray(parsed.hooks)) throw new Error(`Invalid Trae hooks config: ${path}`);
  return parsed;
}

function isOurHandler(handler: unknown, command: string): boolean {
  return Boolean(handler && typeof handler === "object" && (handler as HookHandler).type === "command" && (handler as HookHandler).command === command);
}

const TRAE_STATUS_MESSAGE = "injecting OpenContinuity memory";

function isManagedHandler(handler: unknown, commands: Set<string>): boolean {
  if (!handler || typeof handler !== "object") return false;
  const value = handler as HookHandler;
  return value.type === "command" && typeof value.command === "string"
    && (commands.has(value.command) || value.statusMessage === TRAE_STATUS_MESSAGE);
}

function removeManagedHandlers(groups: HookGroup[], commands: Set<string>): { groups: HookGroup[]; removed: number } {
  let removed = 0;
  const retained = groups.flatMap((group) => {
    if (!Array.isArray(group.hooks)) return [group];
    const hooks = group.hooks.filter((handler) => {
      const owned = isManagedHandler(handler, commands);
      if (owned) removed += 1;
      return !owned;
    });
    return hooks.length > 0 ? [{ ...group, hooks }] : [];
  });
  return { groups: retained, removed };
}

function writeJsonAtomic(path: string, document: HooksDocument): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.${process.pid}.tmp`;
  writeFileSync(temporary, JSON.stringify(document, null, 2) + "\n", { encoding: "utf8", mode: 0o600 });
  renameSync(temporary, path);
}

function backupPath(env: NodeJS.ProcessEnv, path: string): string {
  const directory = join(continuityHome(env), "backups");
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  return join(directory, `trae-hooks-${new Date().toISOString().replaceAll(":", "-")}-${basename(path)}`);
}

export interface TraeHookStatus { path: string; exists: boolean; valid: boolean; installed: boolean; command: string; detail?: string; }

export class TraeInjectionAdapter implements InjectionAdapter<InjectionHookOutput> {
  readonly id = "trae";
  readonly hookEvent = "UserPromptSubmit";

  constructor(
    private readonly env: NodeJS.ProcessEnv = process.env,
    private readonly nodePath = process.execPath,
    private readonly hookPath = "",
  ) {}

  emptyOutput(): InjectionHookOutput {
    return { continue: true, suppressOutput: true };
  }

  renderContext(context: string): InjectionHookOutput {
    if (!context) return this.emptyOutput();
    return {
      continue: true, suppressOutput: true,
      hookSpecificOutput: {
        hookEventName: "UserPromptSubmit",
        additionalContext: renderMemoryContext(context),
      },
    };
  }

  check(): TraeHookStatus {
    return checkTraeInjectionHook(this.env, this.nodePath, this.hookPath);
  }

  install(): TraeHookStatus & { changed: boolean; backupPath?: string } {
    if (!this.hookPath) throw new Error("Trae Injection Adapter requires a hook executable path before installation");
    return installTraeInjectionHook(this.env, this.nodePath, this.hookPath);
  }

  uninstall(): TraeHookStatus & { changed: boolean; backupPath?: string } {
    return uninstallTraeInjectionHook(this.env, this.nodePath, this.hookPath);
  }
}

export function checkTraeInjectionHook(env: NodeJS.ProcessEnv = process.env, nodePath = process.execPath, hookPath = ""): TraeHookStatus {
  const path = traeHookConfigPath(env);
  const command = injectionHookCommand(nodePath, hookPath);
  if (!existsSync(path)) return { path, exists: false, valid: true, installed: false, command, detail: "hooks.json does not exist" };
  try {
    const document = readHooks(path);
    const entries = document.hooks?.UserPromptSubmit;
    const groups = Array.isArray(entries) ? entries as HookGroup[] : [];
    const installed = groups.some((group) => Array.isArray(group.hooks) && (group.hooks as unknown[]).some((handler) => isOurHandler(handler, command)));
    return { path, exists: true, valid: true, installed, command, ...(installed ? {} : { detail: "OpenContinuity UserPromptSubmit hook is not installed" }) };
  } catch (error) {
    return { path, exists: true, valid: false, installed: false, command, detail: error instanceof Error ? error.message : String(error) };
  }
}

export function installTraeInjectionHook(env: NodeJS.ProcessEnv = process.env, nodePath = process.execPath, hookPath: string): TraeHookStatus & { changed: boolean; backupPath?: string } {
  const path = traeHookConfigPath(env);
  const command = injectionHookCommand(nodePath, hookPath);
  const document = readHooks(path);
  const events = document.hooks ?? (document.hooks = {});
  const groups = Array.isArray(events.UserPromptSubmit) ? events.UserPromptSubmit as HookGroup[] : [];
  const priorCommands = new Set(managedHooks("trae", env).filter((hook) => hook.event === "UserPromptSubmit").map((hook) => hook.command));
  const currentInstalled = groups.some((group) => Array.isArray(group.hooks) && (group.hooks as unknown[]).some((handler) => isOurHandler(handler, command)));
  const stale = groups.some((group) => Array.isArray(group.hooks) && (group.hooks as unknown[]).some((handler) => isManagedHandler(handler, priorCommands) && !isOurHandler(handler, command)));
  if (currentInstalled && !stale) {
    recordManagedHooks("trae", path, [{ event: "UserPromptSubmit", command }], env);
    return { path, exists: true, valid: true, installed: true, command, changed: false };
  }
  const backup = existsSync(path) ? backupPath(env, path) : undefined;
  if (backup) copyFileSync(path, backup);
  const reconciled = removeManagedHandlers(groups, priorCommands).groups;
  reconciled.push({ hooks: [{ type: "command", command, timeout: 1, statusMessage: TRAE_STATUS_MESSAGE }] });
  events.UserPromptSubmit = reconciled;
  writeJsonAtomic(path, document);
  recordManagedHooks("trae", path, [{ event: "UserPromptSubmit", command }], env);
  return { path, exists: true, valid: true, installed: true, command, changed: true, ...(backup ? { backupPath: backup } : {}) };
}

export function uninstallTraeInjectionHook(env: NodeJS.ProcessEnv = process.env, nodePath = process.execPath, hookPath = ""): TraeHookStatus & { changed: boolean; backupPath?: string } {
  const path = traeHookConfigPath(env);
  const command = injectionHookCommand(nodePath, hookPath);
  if (!existsSync(path)) {
    clearManagedHooks("trae", env);
    return { path, exists: false, valid: true, installed: false, command, changed: false, detail: "hooks.json does not exist" };
  }
  const document = readHooks(path);
  const events = document.hooks ?? (document.hooks = {});
  const groups = Array.isArray(events.UserPromptSubmit) ? events.UserPromptSubmit as HookGroup[] : [];
  const commands = new Set([command, ...managedHooks("trae", env).filter((hook) => hook.event === "UserPromptSubmit").map((hook) => hook.command)]);
  const result = removeManagedHandlers(groups, commands);
  if (result.removed === 0) {
    clearManagedHooks("trae", env);
    return { ...checkTraeInjectionHook(env, nodePath, hookPath), installed: false, changed: false };
  }
  const backup = backupPath(env, path);
  copyFileSync(path, backup);
  if (result.groups.length > 0) events.UserPromptSubmit = result.groups;
  else delete events.UserPromptSubmit;
  writeJsonAtomic(path, document);
  clearManagedHooks("trae", env);
  return { ...checkTraeInjectionHook(env, nodePath, hookPath), installed: false, changed: true, backupPath: backup };
}
