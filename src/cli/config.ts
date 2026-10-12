import { randomUUID } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, readFileSync, realpathSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { z } from "zod";

export const agentNameSchema = z.enum(["trae", "claude", "codex"]);
export type AgentName = z.infer<typeof agentNameSchema>;

const defaultInjectionPolicy = { tokenBudget: 800, maxMemories: 8, timeoutMs: 200, receiptRetentionDays: 30, maxReceipts: 5000 };
const defaultCapturePolicy = { retentionDays: 7, pendingCandidateRetentionDays: 30, autoCleanup: true, intervalMs: 5000, pageSize: 20, maxThreads: 100, retryLimit: 3 };
const injectionPolicySchema = z.object({
  tokenBudget: z.number().int().min(64).max(800).default(800),
  maxMemories: z.number().int().min(1).max(8).default(8),
  timeoutMs: z.number().int().min(25).max(200).default(200),
  receiptRetentionDays: z.number().int().min(1).max(3650).default(30),
  maxReceipts: z.number().int().min(100).max(100_000).default(5000),
});
export type InjectionPolicy = z.infer<typeof injectionPolicySchema>;

const capturePolicySchema = z.object({
  retentionDays: z.number().int().min(1).max(3650).default(7),
  pendingCandidateRetentionDays: z.number().int().min(1).max(3650).default(30),
  autoCleanup: z.boolean().default(true),
  intervalMs: z.number().int().min(1000).max(86_400_000).default(5000),
  pageSize: z.number().int().min(1).max(100).default(20),
  maxThreads: z.number().int().min(1).max(1000).default(100),
  retryLimit: z.number().int().min(0).max(10).default(3),
});
export type CapturePolicy = z.infer<typeof capturePolicySchema>;

const adapterFeatureConfigSchema = z.object({
  enabled: z.boolean().default(false),
  workspaces: z.array(z.string().min(1)).default([]),
});
export type AdapterFeatureConfig = z.infer<typeof adapterFeatureConfigSchema>;
export type InjectionConfig = InjectionPolicy & AdapterFeatureConfig;
export type CaptureConfig = CapturePolicy & AdapterFeatureConfig;

const connectedAgentSchema = z.object({
  binary: z.string(), connectedAt: z.string(), backupPath: z.string().optional(), databasePath: z.string().optional(),
  serverPath: z.string().optional(), nodePath: z.string().optional(),
});

const legacyInjectionConfigSchema = injectionPolicySchema.extend({
  enabled: z.boolean().default(false),
  workspaces: z.array(z.string().min(1)).default([]),
});
const legacyCaptureConfigSchema = capturePolicySchema.extend({
  enabled: z.boolean().default(false),
  workspaces: z.array(z.string().min(1)).default([]),
});

const legacyConfigSchema = z.object({
  version: z.literal(1), userId: z.string().min(1), databasePath: z.string().min(1),
  connectedAgents: z.partialRecord(agentNameSchema, connectedAgentSchema).default({}),
  injection: legacyInjectionConfigSchema.default({ enabled: false, workspaces: [], ...defaultInjectionPolicy }),
  capture: legacyCaptureConfigSchema.default({ enabled: false, workspaces: [], ...defaultCapturePolicy }),
});

const configSchema = z.object({
  version: z.literal(2), userId: z.string().min(1), databasePath: z.string().min(1),
  connectedAgents: z.partialRecord(agentNameSchema, connectedAgentSchema).default({}),
  injection: injectionPolicySchema.default(defaultInjectionPolicy),
  capture: capturePolicySchema.default(defaultCapturePolicy),
  adapters: z.object({
    trae: z.object({ injection: adapterFeatureConfigSchema, capture: adapterFeatureConfigSchema }),
    claude: z.object({ injection: adapterFeatureConfigSchema, capture: adapterFeatureConfigSchema }),
    codex: z.object({ injection: adapterFeatureConfigSchema, capture: adapterFeatureConfigSchema }),
  }),
});
export type LocalConfig = z.infer<typeof configSchema>;

function disabledAdapterConfig(): { injection: AdapterFeatureConfig; capture: AdapterFeatureConfig } {
  return { injection: { enabled: false, workspaces: [] }, capture: { enabled: false, workspaces: [] } };
}

function migrateLegacyConfig(legacy: z.infer<typeof legacyConfigSchema>): LocalConfig {
  const connected = agentNameSchema.options.filter((agent) => legacy.connectedAgents[agent]);
  // Before v2 the granular CLI implicitly targeted Trae. If no connector was
  // recorded, assigning legacy permissions to Trae preserves behavior without
  // silently granting the same workspace to every adapter.
  const targets: AgentName[] = connected.length > 0 ? connected : ["trae"];
  const adapters = {
    trae: disabledAdapterConfig(),
    claude: disabledAdapterConfig(),
    codex: disabledAdapterConfig(),
  };
  for (const agent of targets) {
    adapters[agent] = {
      injection: { enabled: legacy.injection.enabled, workspaces: [...legacy.injection.workspaces] },
      capture: { enabled: legacy.capture.enabled, workspaces: [...legacy.capture.workspaces] },
    };
  }
  const { enabled: _injectionEnabled, workspaces: _injectionWorkspaces, ...injection } = legacy.injection;
  const { enabled: _captureEnabled, workspaces: _captureWorkspaces, ...capture } = legacy.capture;
  return configSchema.parse({
    version: 2,
    userId: legacy.userId,
    databasePath: legacy.databasePath,
    connectedAgents: legacy.connectedAgents,
    injection,
    capture,
    adapters,
  });
}

export function continuityHome(env: NodeJS.ProcessEnv = process.env): string {
  return resolve(env.OPEN_CONTINUITY_HOME || join(env.HOME || homedir(), ".open-continuity"));
}

export function normalizeWorkspacePath(path: string): string {
  const resolved = resolve(path);
  try { return realpathSync(resolved); } catch { return resolved; }
}

export function isWorkspaceAllowed(workspaces: string[], path: string): boolean {
  const workspace = normalizeWorkspacePath(path);
  return workspaces.some((allowed) => {
    const normalized = normalizeWorkspacePath(allowed);
    return workspace === normalized || workspace.startsWith(normalized.endsWith("/") ? normalized : normalized + "/");
  });
}

export function configPath(env: NodeJS.ProcessEnv = process.env): string { return join(continuityHome(env), "config.json"); }

export function defaultConfig(env: NodeJS.ProcessEnv = process.env): LocalConfig {
  return {
    version: 2,
    userId: `local-${randomUUID()}`,
    databasePath: join(continuityHome(env), "memories.db"),
    connectedAgents: {},
    injection: { ...defaultInjectionPolicy },
    capture: { ...defaultCapturePolicy },
    adapters: { trae: disabledAdapterConfig(), claude: disabledAdapterConfig(), codex: disabledAdapterConfig() },
  };
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): LocalConfig | null {
  const path = configPath(env);
  if (!existsSync(path)) return null;
  const raw: unknown = JSON.parse(readFileSync(path, "utf8"));
  const version = raw && typeof raw === "object" ? (raw as { version?: unknown }).version : undefined;
  if (version === 2) return configSchema.parse(raw);
  const migrated = migrateLegacyConfig(legacyConfigSchema.parse(raw));
  const backupPath = `${path}.v1.backup`;
  if (!existsSync(backupPath)) copyFileSync(path, backupPath);
  saveConfig(migrated, env);
  return migrated;
}

export function adapterInjectionConfig(config: LocalConfig, agent: AgentName): InjectionConfig {
  return { ...config.injection, ...config.adapters[agent].injection };
}

export function adapterCaptureConfig(config: LocalConfig, agent: AgentName): CaptureConfig {
  return { ...config.capture, ...config.adapters[agent].capture };
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
