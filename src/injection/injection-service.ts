import { createHash, randomUUID } from "node:crypto";
import { MemoryService } from "../core/memory-service.js";
import { estimateContextTokens } from "../core/context-pack.js";
import { SqliteMemoryStore } from "../sqlite/sqlite-memory-store.js";
import { adapterInjectionConfig, agentNameSchema, loadConfig, normalizeWorkspacePath, isWorkspaceAllowed, type InjectionConfig, type LocalConfig } from "../cli/config.js";
import type { ContextPackInput, ContextPackResult } from "../shared/types.js";
import type { InjectionHookInput, InjectionHookOutput, InjectionReceipt, InjectionOutcome } from "./types.js";
import type { InjectionAdapter } from "../adapters/contracts.js";
import { TraeInjectionAdapter } from "./trae-hook-config.js";
import { appendInjectionReceipt } from "./receipt-store.js";

type InjectionRuntimeService = { context(input: ContextPackInput): Promise<ContextPackResult>; close(): Promise<void> };
export interface InjectionRuntime {
  createService?: (config: LocalConfig) => InjectionRuntimeService;
  adapter?: InjectionAdapter<InjectionHookOutput>;
}

function injectionQuery(prompt: string): string {
  const normalized = prompt.trim();
  // Prefer explicit topic identifiers from natural-language questions. Trae
  // users often ask "讨论 PROJECT_X 时……"; passing that entire sentence to
  // SQLite FTS phrase search makes an otherwise exact memory impossible to
  // match. Keep this narrow so the hook does not broaden every prompt.
  const topicIdentifier = normalized.match(/(?:关于|讨论|针对|围绕|查询|查找|搜索)\s*["“‘']?([A-Za-z0-9][A-Za-z0-9_.:/-]{2,})["”’']?/u)?.[1];
  if (topicIdentifier) return topicIdentifier;
  // Keep the first content clause after common instruction markers. This is
  // deliberately conservative: the hook should miss a memory rather than
  // inject a broad, weakly related pack on every prompt.
  const marker = normalized.match(/(?:按照|使用|参考|遵循|采用|按|记住|with|using|follow|remember(?: that)?)\s*/iu);
  const afterMarker = marker ? normalized.slice(marker.index! + marker[0].length) : "";
  const clauseEnd = afterMarker.search(/的(?:风格|方式)|(?:完成|处理|执行|继续|用于|来)|[，。！？,.!?]/iu);
  const clause = (clauseEnd >= 0 ? afterMarker.slice(0, clauseEnd) : afterMarker.slice(0, 32)).trim();
  if (clause && [...clause].length >= 3) return clause;
  return normalized;
}
function fingerprint(prompt: string): string {
  return createHash("sha256").update(prompt).digest("hex").slice(0, 24);
}
function recordReceipt(env: NodeJS.ProcessEnv, config: LocalConfig, receipt: InjectionReceipt): void {
  appendInjectionReceipt(env, receipt, config.injection);
}

function workspaceAllowed(config: InjectionConfig, cwd?: string): boolean {
  if (!config.enabled || !cwd) return false;
  return isWorkspaceAllowed(config.workspaces, cwd);
}

function makeReceipt(input: { agentId: string; hook: InjectionHookInput; outcome: InjectionOutcome; startedAt: number; memoryIds?: string[]; reasons?: string[]; tokenEstimate?: number; detail?: string }): InjectionReceipt {
  return {
    id: randomUUID(), agentId: input.agentId, workspacePath: input.hook.cwd ? normalizeWorkspacePath(input.hook.cwd) : undefined,
    sessionId: typeof input.hook.session_id === "string" ? input.hook.session_id : undefined,
    turnId: typeof input.hook.turn_id === "string" ? input.hook.turn_id : undefined,
    promptFingerprint: typeof input.hook.prompt === "string" ? fingerprint(input.hook.prompt) : undefined,
    memoryIds: input.memoryIds ?? [], reasons: input.reasons ?? [], tokenEstimate: input.tokenEstimate ?? 0,
    latencyMs: Date.now() - input.startedAt, outcome: input.outcome, createdAt: new Date().toISOString(), detail: input.detail,
  };
}

function renderedContextText(output: InjectionHookOutput): string {
  return output.hookSpecificOutput?.additionalContext ?? "";
}

function contextBudgetForHook(adapter: InjectionAdapter<InjectionHookOutput>, totalBudget: number): number {
  const probe = renderedContextText(adapter.renderContext("x"));
  const wrapperTokens = Math.max(0, estimateContextTokens(probe) - estimateContextTokens("x"));
  return totalBudget - wrapperTokens;
}

export async function runInjectionHook(input: InjectionHookInput, env: NodeJS.ProcessEnv = process.env, runtime: InjectionRuntime = {}): Promise<InjectionHookOutput> {
  const startedAt = Date.now();
  const adapter = runtime.adapter ?? new TraeInjectionAdapter(env);
  const agentId = adapter.id;
  let config: LocalConfig | null = null;
  try {
    config = loadConfig(env);
    const agent = agentNameSchema.parse(agentId);
    const injection = config ? adapterInjectionConfig(config, agent) : null;
    if (!config || !injection || !workspaceAllowed(injection, input.cwd)) {
      if (config) recordReceipt(env, config, makeReceipt({ agentId, hook: input, outcome: "disabled", startedAt, detail: "injection_disabled_or_workspace_not_allowed" }));
      return adapter.emptyOutput();
    }
    if (!input.prompt?.trim()) {
      recordReceipt(env, config, makeReceipt({ agentId, hook: input, outcome: "skipped", startedAt, detail: "missing_prompt" }));
      return adapter.emptyOutput();
    }
    const service = runtime.createService?.(config) ?? new MemoryService(new SqliteMemoryStore(config.databasePath), {}, { defaultTokenBudget: injection.tokenBudget, maxTokenBudget: injection.tokenBudget, maxMemories: injection.maxMemories, requireUserConfirmed: true });
    try {
      const contextBudget = contextBudgetForHook(adapter, injection.tokenBudget);
      if (contextBudget < 64) {
        recordReceipt(env, config, makeReceipt({ agentId, hook: input, outcome: "skipped", startedAt, reasons: ["render_budget"], detail: "injection_budget_too_small" }));
        return adapter.emptyOutput();
      }
      let timeoutHandle: NodeJS.Timeout | undefined;
      try {
        const pack = await Promise.race([
          service.context({ userId: config.userId, agentId, query: injectionQuery(input.prompt), includePrivate: false, purpose: "general", tokenBudget: contextBudget, maxMemories: injection.maxMemories }),
          new Promise<never>((_, reject) => { timeoutHandle = setTimeout(() => reject(new Error("injection timeout")), injection.timeoutMs); }),
        ]);
        const outcome = pack.items.length ? "injected" : "skipped";
        const rendered = adapter.renderContext(pack.context);
        const renderedTokens = estimateContextTokens(renderedContextText(rendered));
        if (renderedTokens > injection.tokenBudget) {
          recordReceipt(env, config, makeReceipt({ agentId, hook: input, outcome: "skipped", startedAt, reasons: ["render_budget"], detail: "injection_render_budget_exceeded" }));
          return adapter.emptyOutput();
        }
        recordReceipt(env, config, makeReceipt({ agentId, hook: input, outcome, startedAt, memoryIds: pack.items.map((item) => item.memoryId), reasons: [...new Set(pack.items.flatMap((item) => item.reasons))], tokenEstimate: renderedTokens, detail: pack.items.length ? undefined : "no_relevant_public_memory" }));
        return rendered;
      } finally {
        if (timeoutHandle) clearTimeout(timeoutHandle);
      }
    } finally { await service.close(); }
  } catch (error) {
    if (config) {
      try { recordReceipt(env, config, makeReceipt({ agentId, hook: input, outcome: error instanceof Error && error.message === "injection timeout" ? "timeout" : "failed", startedAt, detail: error instanceof Error && error.message === "injection timeout" ? "injection_timeout" : "injection_failed" })); } catch { /* fail open */ }
    }
    return adapter.emptyOutput();
  }
}
