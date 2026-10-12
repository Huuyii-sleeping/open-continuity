import type { AgentName } from "../cli/config.js";
import { ClaudeInjectionAdapter, type ClaudeHookPaths } from "../injection/claude-hook-config.js";
import { CodexInjectionAdapter, type CodexHookPaths } from "../injection/codex-hook-config.js";
import { TraeInjectionAdapter } from "../injection/trae-hook-config.js";
import type { InjectionHookOutput } from "../injection/types.js";
import type { InjectionAdapter } from "./contracts.js";

export interface AdapterInjectionPaths {
  trae: { injectionHookPath: string };
  claude: ClaudeHookPaths;
  codex: CodexHookPaths;
}

interface AdapterDescriptor {
  id: AgentName;
  createInjectionAdapter(
    env: NodeJS.ProcessEnv,
    nodePath: string,
    paths: AdapterInjectionPaths,
  ): InjectionAdapter<InjectionHookOutput>;
}

export const adapterRegistry: Record<AgentName, AdapterDescriptor> = {
  trae: {
    id: "trae",
    createInjectionAdapter: (env, nodePath, paths) => new TraeInjectionAdapter(env, nodePath, paths.trae.injectionHookPath),
  },
  claude: {
    id: "claude",
    createInjectionAdapter: (env, nodePath, paths) => new ClaudeInjectionAdapter(env, nodePath, paths.claude),
  },
  codex: {
    id: "codex",
    createInjectionAdapter: (env, nodePath, paths) => new CodexInjectionAdapter(env, nodePath, paths.codex),
  },
};

export function createInjectionAdapter(
  agent: AgentName,
  env: NodeJS.ProcessEnv,
  nodePath: string,
  paths: AdapterInjectionPaths,
): InjectionAdapter<InjectionHookOutput> {
  return adapterRegistry[agent].createInjectionAdapter(env, nodePath, paths);
}
