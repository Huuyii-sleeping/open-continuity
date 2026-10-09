import { copyFileSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { continuityHome } from "../cli/config.js";

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
  if (groups.some((group) => Array.isArray(group.hooks) && (group.hooks as unknown[]).some((handler) => isOurHandler(handler, command)))) {
    return { path, exists: true, valid: true, installed: true, command, changed: false };
  }
  const backup = existsSync(path) ? backupPath(env, path) : undefined;
  if (backup) copyFileSync(path, backup);
  groups.push({ hooks: [{ type: "command", command, timeout: 1, statusMessage: "injecting OpenContinuity memory" }] });
  events.UserPromptSubmit = groups;
  writeJsonAtomic(path, document);
  return { path, exists: true, valid: true, installed: true, command, changed: true, ...(backup ? { backupPath: backup } : {}) };
}
