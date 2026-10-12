import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { z } from "zod";
import { agentNameSchema, continuityHome, type AgentName } from "../cli/config.js";

const managedHookSchema = z.object({
  event: z.enum(["UserPromptSubmit", "Stop"]),
  command: z.string().min(1),
  args: z.array(z.string()).optional(),
});
export type ManagedHook = z.infer<typeof managedHookSchema>;

const manifestSchema = z.object({
  version: z.literal(1),
  agents: z.partialRecord(agentNameSchema, z.object({
    configPath: z.string().min(1),
    hooks: z.array(managedHookSchema),
    updatedAt: z.string(),
  })).default({}),
});
type HookManifest = z.infer<typeof manifestSchema>;

export function hookManifestPath(env: NodeJS.ProcessEnv = process.env): string {
  return join(continuityHome(env), "hook-manifest.json");
}

function readManifest(env: NodeJS.ProcessEnv): HookManifest {
  const path = hookManifestPath(env);
  if (!existsSync(path)) return { version: 1, agents: {} };
  return manifestSchema.parse(JSON.parse(readFileSync(path, "utf8")));
}

function writeManifest(manifest: HookManifest, env: NodeJS.ProcessEnv): void {
  const path = hookManifestPath(env);
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.${process.pid}.tmp`;
  writeFileSync(temporary, JSON.stringify(manifest, null, 2) + "\n", { encoding: "utf8", mode: 0o600 });
  renameSync(temporary, path);
}

export function managedHooks(agent: AgentName, env: NodeJS.ProcessEnv = process.env): ManagedHook[] {
  return readManifest(env).agents[agent]?.hooks ?? [];
}

export function recordManagedHooks(agent: AgentName, configPath: string, hooks: ManagedHook[], env: NodeJS.ProcessEnv = process.env): void {
  const manifest = readManifest(env);
  const existing = manifest.agents[agent];
  if (existing?.configPath === configPath && JSON.stringify(existing.hooks) === JSON.stringify(hooks)) return;
  manifest.agents[agent] = { configPath, hooks, updatedAt: new Date().toISOString() };
  writeManifest(manifest, env);
}

export function clearManagedHooks(agent: AgentName, env: NodeJS.ProcessEnv = process.env): void {
  const manifest = readManifest(env);
  if (!manifest.agents[agent]) return;
  delete manifest.agents[agent];
  writeManifest(manifest, env);
}
