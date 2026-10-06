import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { z } from "zod";

export const agentNameSchema = z.enum(["trae", "claude", "codex"]);
export type AgentName = z.infer<typeof agentNameSchema>;

const configSchema = z.object({
  version: z.literal(1), userId: z.string().min(1), databasePath: z.string().min(1),
  connectedAgents: z.partialRecord(agentNameSchema, z.object({ binary: z.string(), connectedAt: z.string(), backupPath: z.string().optional(), databasePath: z.string().optional() })).default({}),
});
export type LocalConfig = z.infer<typeof configSchema>;

export function continuityHome(env: NodeJS.ProcessEnv = process.env): string {
  return resolve(env.OPEN_CONTINUITY_HOME || join(env.HOME || homedir(), ".open-continuity"));
}

export function configPath(env: NodeJS.ProcessEnv = process.env): string { return join(continuityHome(env), "config.json"); }

export function defaultConfig(env: NodeJS.ProcessEnv = process.env): LocalConfig {
  return { version: 1, userId: `local-${randomUUID()}`, databasePath: join(continuityHome(env), "memories.db"), connectedAgents: {} };
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
