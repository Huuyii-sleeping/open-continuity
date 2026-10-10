import { spawn, spawnSync, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createInterface } from "node:readline";
import { z } from "zod";
import { findExecutable } from "../cli/connectors.js";
import type { ConversationItem, ConversationThread, ConversationTurn } from "./types.js";
import type { CaptureAdapter, CaptureListResult, CaptureThreadReference } from "../adapters/contracts.js";

const userInputSchema = z.object({ type: z.string(), text: z.string().optional() }).passthrough();
const threadItemSchema = z.object({ id: z.string(), type: z.string() }).passthrough();
const turnSchema = z.object({
  id: z.string(), status: z.string(), items: z.array(threadItemSchema),
  startedAt: z.number().nullable().optional(), completedAt: z.number().nullable().optional(),
}).passthrough();
const threadSchema = z.object({
  id: z.string(), sessionId: z.string(), cwd: z.string(), cliVersion: z.string(), preview: z.string(),
  createdAt: z.number(), updatedAt: z.number(), ephemeral: z.boolean(), turns: z.array(turnSchema),
}).passthrough();
const listResultSchema = z.object({ data: z.array(threadSchema), nextCursor: z.string().nullable().optional() }).passthrough();
const readResultSchema = z.object({ thread: threadSchema }).passthrough();

interface JsonRpcResponse { id?: number; result?: unknown; error?: { message?: string } }
interface PendingRequest { resolve: (value: unknown) => void; reject: (error: Error) => void; timeout: NodeJS.Timeout; }

export interface TraeCaptureCapabilities {
  available: boolean; binary: string | null; version: string | null; appServer: boolean;
  hookPath: string; captureModes: Array<"app_server" | "hook">; detail?: string;
}

function timestamp(value: number | null | undefined): string | undefined {
  if (value == null) return undefined;
  const milliseconds = value < 10_000_000_000 ? value * 1000 : value;
  return new Date(milliseconds).toISOString();
}

function turnStatus(value: string): ConversationTurn["status"] {
  if (value === "completed" || value === "failed" || value === "interrupted" || value === "in_progress") return value;
  if (value === "inProgress") return "in_progress";
  return "unknown";
}

function itemText(content: unknown): string {
  if (!Array.isArray(content)) return "";
  return content.map((entry) => userInputSchema.safeParse(entry)).filter((entry) => entry.success)
    .map((entry) => entry.data.text ?? "").filter(Boolean).join("\n");
}

function normalizeItem(item: z.infer<typeof threadItemSchema>): ConversationItem {
  const raw = item as Record<string, unknown>;
  if (item.type === "userMessage") return { id: item.id, type: "user_message", text: itemText(raw.content), rawType: item.type };
  if (item.type === "agentMessage") {
    const phase = raw.phase === "commentary" || raw.phase === "final_answer" ? raw.phase : undefined;
    return { id: item.id, type: "assistant_message", text: typeof raw.text === "string" ? raw.text : "", ...(phase ? { phase } : {}), rawType: item.type };
  }
  if (item.type === "commandExecution") return {
    id: item.id, type: "tool_call", toolName: "shell", toolInput: { command: raw.command, cwd: raw.cwd },
    toolOutput: raw.aggregatedOutput, toolStatus: typeof raw.status === "string" ? raw.status : undefined, rawType: item.type,
  };
  if (item.type === "mcpToolCall" || item.type === "dynamicToolCall" || item.type === "collabAgentToolCall") return {
    id: item.id, type: "tool_call", toolName: [raw.server, raw.tool].filter((part) => typeof part === "string").join("/") || item.type,
    toolInput: raw.arguments ?? raw.prompt, toolOutput: raw.result ?? raw.contentItems,
    toolStatus: typeof raw.status === "string" ? raw.status : undefined, rawType: item.type,
  };
  if (item.type === "contextCompaction") return { id: item.id, type: "compaction", rawType: item.type };
  return { id: item.id, type: "other", rawType: item.type };
}

function normalizeTurn(turn: z.infer<typeof turnSchema>): ConversationTurn {
  const status = turnStatus(turn.status);
  const items = turn.items.map(normalizeItem);
  const hasUser = items.some((item) => item.type === "user_message" && item.text);
  const hasFinal = items.some((item) => item.type === "assistant_message" && item.phase === "final_answer" && item.text);
  const quality = status === "completed" && hasUser && hasFinal ? "complete" : status === "interrupted" ? "interrupted" : "partial";
  const startedAt = timestamp(turn.startedAt); const completedAt = timestamp(turn.completedAt);
  return { id: turn.id, status, quality, ...(startedAt ? { startedAt } : {}), ...(completedAt ? { completedAt } : {}), items };
}

function normalizeThread(thread: z.infer<typeof threadSchema>): ConversationThread {
  return { source: "trae", id: thread.id, sessionId: thread.sessionId, cwd: thread.cwd, cliVersion: thread.cliVersion, ephemeral: thread.ephemeral, preview: thread.preview,
    createdAt: timestamp(thread.createdAt)!, updatedAt: timestamp(thread.updatedAt)!, turns: thread.turns.map(normalizeTurn) };
}

export function probeTraeCapture(env: NodeJS.ProcessEnv = process.env): TraeCaptureCapabilities {
  const binary = findExecutable(["traecli", "traex"], env);
  const home = env.TRAECLI_HOME || (env.TRAE_HOME ? env.TRAE_HOME + "/cli" : (env.HOME || "") + "/.trae/cli");
  if (!binary) return { available: false, binary: null, version: null, appServer: false, hookPath: home + "/hooks.json", captureModes: [], detail: "Trae executable not found" };
  const version = spawnSync(binary, ["--version"], { env, encoding: "utf8", timeout: 10_000 });
  const help = spawnSync(binary, ["app-server", "--help"], { env, encoding: "utf8", timeout: 10_000 });
  const appServer = help.status === 0;
  return { available: true, binary, version: [version.stdout, version.stderr].join(" ").trim() || null, appServer,
    hookPath: home + "/hooks.json", captureModes: appServer ? ["app_server"] : [],
    ...(appServer ? {} : { detail: "This Trae installation does not expose app-server" }) };
}

export class TraeAppServerClient implements CaptureAdapter {
  readonly id = "trae";
  private process: ChildProcessWithoutNullStreams | null = null;
  private nextId = 1;
  private readonly pending = new Map<number, PendingRequest>();

  constructor(private readonly binary: string, private readonly env: NodeJS.ProcessEnv = process.env) {}

  async connect(): Promise<void> {
    if (this.process) return;
    const child = spawn(this.binary, ["app-server", "--listen", "stdio://", "--session-source", "cli"], { env: this.env, stdio: ["pipe", "pipe", "pipe"] });
    this.process = child;
    child.once("exit", (code) => this.failAll(new Error("Trae app-server exited with code " + (code ?? "unknown"))));
    child.once("error", (error) => this.failAll(error));
    child.stderr.resume();
    createInterface({ input: child.stdout }).on("line", (line) => this.handleLine(line));
    await this.request("initialize", { clientInfo: { name: "open_continuity", title: "OpenContinuity", version: "1" } });
    this.notify("initialized", {});
  }

  async listThreads(input: { pageSize?: number; maxThreads?: number } = {}): Promise<CaptureListResult> {
    const pageSize = input.pageSize ?? 20;
    const maxThreads = input.maxThreads ?? 100;
    const threads: Array<z.infer<typeof threadSchema>> = [];
    let cursor: string | undefined;
    let pages = 0;
    do {
      const result = listResultSchema.parse(await this.request("thread/list", {
        limit: Math.min(pageSize, maxThreads - threads.length),
        ...(cursor ? { cursor } : {}),
        sortKey: "updated_at", sortDirection: "desc", sourceKinds: ["cli", "exec"], useStateDbOnly: false,
      }));
      pages += 1;
      threads.push(...result.data);
      cursor = result.nextCursor ?? undefined;
    } while (cursor && threads.length < maxThreads);
    const references: CaptureThreadReference[] = threads.slice(0, maxThreads).map((thread) => ({
      id: thread.id, cwd: thread.cwd, updatedAt: timestamp(thread.updatedAt)!, ephemeral: thread.ephemeral,
    }));
    return { threads: references, pages, truncated: Boolean(cursor) };
  }

  async readThread(threadId: string): Promise<ConversationThread> {
    const result = readResultSchema.parse(await this.request("thread/read", { threadId, includeTurns: true }));
    return normalizeThread(result.thread);
  }

  async close(): Promise<void> {
    const child = this.process; this.process = null;
    if (child && !child.killed) child.kill("SIGTERM");
  }

  private request(method: string, params: unknown): Promise<unknown> {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => { this.pending.delete(id); reject(new Error("Trae app-server request timed out: " + method)); }, 15_000);
      this.pending.set(id, { resolve, reject, timeout }); this.write({ id, method, params });
    });
  }
  private notify(method: string, params: unknown): void { this.write({ method, params }); }
  private write(message: unknown): void {
    if (!this.process) throw new Error("Trae app-server is not connected");
    this.process.stdin.write(JSON.stringify(message) + "\n");
  }
  private handleLine(line: string): void {
    let response: JsonRpcResponse;
    try { response = JSON.parse(line) as JsonRpcResponse; } catch { return; }
    if (typeof response.id !== "number") return;
    const pending = this.pending.get(response.id); if (!pending) return;
    clearTimeout(pending.timeout); this.pending.delete(response.id);
    if (response.error) pending.reject(new Error(response.error.message || "Trae app-server request failed"));
    else pending.resolve(response.result);
  }
  private failAll(error: Error): void {
    for (const pending of this.pending.values()) { clearTimeout(pending.timeout); pending.reject(error); }
    this.pending.clear();
  }
}
