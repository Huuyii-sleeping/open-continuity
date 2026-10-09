import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, realpathSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { z } from "zod";

export const agentNameSchema = z.enum(["trae", "claude", "codex"]);
export type AgentName = z.infer<typeof agentNameSchema>;

const defaultInjectionConfig = { enabled: false, workspaces: [] as string[], tokenBudget: 800, maxMemories: 8, timeoutMs: 200 };
const defaultCaptureConfig = { retentionDays: 7, autoCleanup: true, intervalMs: 5000, pageSize: 20, maxThreads: 100, retryLimit: 3 };
const injectionConfigSchema = z.object({
  enabled: z.boolean().default(false),
  workspaces: z.array(z.string().min(1)).default([]),
  tokenBudget: z.number().int().min(64).max(800).default(800),
  maxMemories: z.number().int().min(1).max(8).default(8),
  timeoutMs: z.number().int().min(25).max(200).default(200),
});
export type InjectionConfig = z.infer<typeof injectionConfigSchema>;

const configSchema = z.object({
  version: z.literal(1), userId: z.string().min(1), databasePath: z.string().min(1),
  connectedAgents: z.partialRecord(agentNameSchema, z.object({
    binary: z.string(), connectedAt: z.string(), backupPath: z.string().optional(), databasePath: z.string().optional(),
    serverPath: z.string().optional(), nodePath: z.string().optional(),
  })).default({}),
  injection: injectionConfigSchema.default(defaultInjectionConfig),
  capture: z.object({
    retentionDays: z.number().int().min(1).max(3650).default(7),
    autoCleanup: z.boolean().default(true),
    intervalMs: z.number().int().min(1000).max(86_400_000).default(5000),
    pageSize: z.number().int().min(1).max(100).default(20),
    maxThreads: z.number().int().min(1).max(1000).default(100),
    retryLimit: z.number().int().min(0).max(10).default(3),
  }).default(defaultCaptureConfig),
});
export type LocalConfig = z.infer<typeof configSchema>;

export function continuityHome(env: NodeJS.ProcessEnv = process.env): string {
  return resolve(env.OPEN_CONTINUITY_HOME || join(env.HOME || homedir(), ".open-continuity"));
}

export function normalizeWorkspacePath(path: string): string {
  const resolved = resolve(path);
  try { return realpathSync(resolved); } catch { return resolved; }
}

export function configPath(env: NodeJS.ProcessEnv = process.env): string { return join(continuityHome(env), "config.json"); }

export function defaultConfig(env: NodeJS.ProcessEnv = process.env): LocalConfig {
  return { version: 1, userId: `local-${randomUUID()}`, databasePath: join(continuityHome(env), "memories.db"), connectedAgents: {}, injection: { ...defaultInjectionConfig, workspaces: [] }, capture: { ...defaultCaptureConfig } };
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): LocalConfig | null {
  const path = configPath(env);
  return existsSync(path) ? configSchema.parse(JSON.parse(readFileSync(path, "utf8"))) : null;
}

export function requireConfig(env: NodeJS.ProcessEnv = process.env): LocalConfig {
  const config = loadConfig(env);
  if (!config) throw new Error("OpenContinuity is not initialized. Run `open-continuity init` first.");
  return config;
}

export function saveConfig(config: LocalConfig, env: NodeJS.ProcessEnv = process.env): void {
  const path = configPath(env);
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.${process.pid}.tmp`;
  writeFileSync(temporary, JSON.stringify(config, null, 2) + "\n", { encoding: "utf8", mode: 0o600 });
  renameSync(temporary, path);
}

export function ensureConfig(env: NodeJS.ProcessEnv = process.env): { config: LocalConfig; created: boolean } {
  const existing = loadConfig(env);
  if (existing) return { config: existing, created: false };
  const config = defaultConfig(env);
  saveConfig(config, env);
  return { config, created: true };
}
