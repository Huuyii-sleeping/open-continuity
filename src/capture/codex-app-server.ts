import { spawn, spawnSync, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createInterface } from "node:readline";
import { findExecutable } from "../cli/connectors.js";
import type { CaptureAdapter, CaptureListResult, CaptureThreadReference } from "../adapters/contracts.js";
import type { ConversationItem, ConversationThread, ConversationTurn } from "./types.js";

type RecordValue = Record<string, unknown>;

interface JsonRpcResponse {
  id?: number;
  result?: unknown;
  error?: { message?: string };
}

interface PendingRequest {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timeout: NodeJS.Timeout;
}

export interface CodexCaptureCapabilities {
  available: boolean;
  binary: string | null;
  version: string | null;
  appServer: boolean;
  hooksPath: string;
  captureModes: Array<"app_server" | "hook">;
  detail?: string;
}

export interface CodexAppServerClientOptions {
  requestTimeoutMs?: number;
}

function record(value: unknown): RecordValue | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? value as RecordValue : undefined;
}

function string(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value : undefined;
}

function timestamp(value: unknown): string | undefined {
  if (value == null) return undefined;
  const numberValue = typeof value === "number" ? value : Number(value);
  if (Number.isFinite(numberValue)) {
    const milliseconds = numberValue < 10_000_000_000 ? numberValue * 1000 : numberValue;
    return new Date(milliseconds).toISOString();
  }
  if (typeof value === "string") {
    const date = new Date(value);
    if (!Number.isNaN(date.getTime())) return date.toISOString();
  }
  return undefined;
}

function textFromUserInput(value: unknown): string {
  if (typeof value === "string") return value.trim();
  const input = record(value);
  if (!input) return "";
  if (input.type === "text" && typeof input.text === "string") return input.text.trim();
  return "";
}

function userMessageText(value: unknown): string {
  if (!Array.isArray(value)) return "";
  return value.map(textFromUserInput).filter(Boolean).join("\n");
}

function turnStatus(value: unknown): ConversationTurn["status"] {
  const status = typeof value === "string" ? value : string(record(value)?.type);
  if (status === "completed") return "completed";
  if (status === "failed") return "failed";
  if (status === "interrupted") return "interrupted";
  if (status === "inProgress" || status === "in_progress") return "in_progress";
  return "unknown";
}

function phase(value: unknown): ConversationItem["phase"] | undefined {
  if (value === "commentary") return "commentary";
  if (value === "final_answer") return "final_answer";
  return undefined;
}

function normalizeItem(item: unknown): ConversationItem | undefined {
  const raw = record(item);
  if (!raw || typeof raw.id !== "string" || typeof raw.type !== "string") return undefined;
  const id = raw.id;
  switch (raw.type) {
    case "userMessage": {
      const text = userMessageText(raw.content);
      return { id, type: "user_message", ...(text ? { text } : {}), rawType: raw.type };
    }
    case "agentMessage": {
      const text = typeof raw.text === "string" ? raw.text.trim() : "";
      const itemPhase = phase(raw.phase);
      return { id, type: "assistant_message", ...(text ? { text } : {}), ...(itemPhase ? { phase: itemPhase } : {}), rawType: raw.type };
    }
    case "commandExecution":
      return {
        id, type: "tool_call", toolName: "shell",
        toolInput: { command: raw.command, cwd: raw.cwd }, toolOutput: raw.aggregatedOutput,
        toolStatus: typeof raw.status === "string" ? raw.status : undefined, rawType: raw.type,
      };
    case "mcpToolCall":
    case "dynamicToolCall":
    case "collabAgentToolCall":
    case "functionCallOutput":
      return {
        id, type: "tool_call",
        toolName: [raw.server, raw.tool, raw.name].filter((part) => typeof part === "string").join("/") || raw.type,
        toolInput: raw.arguments ?? raw.prompt,
        toolOutput: raw.result ?? raw.output ?? raw.contentItems,
        toolStatus: typeof raw.status === "string" ? raw.status : undefined, rawType: raw.type,
      };
    case "contextCompaction":
      return { id, type: "compaction", rawType: raw.type };
    // Reasoning is intentionally retained only as an item marker. Codex does
    // not promise that reasoning content is safe or user-visible transcript
    // data, so it must never enter candidates or long-term memory.
    case "reasoning":
      return { id, type: "other", rawType: raw.type };
    default:
      return { id, type: "other", rawType: raw.type };
  }
}

function normalizeTurn(turn: unknown): ConversationTurn | undefined {
  const raw = record(turn);
  if (!raw || typeof raw.id !== "string") return undefined;
  const items = Array.isArray(raw.items) ? raw.items.map(normalizeItem).filter((item): item is ConversationItem => Boolean(item)) : [];
  const status = turnStatus(raw.status);
  const hasUser = items.some((item) => item.type === "user_message" && item.text);
  const hasFinal = items.some((item) => item.type === "assistant_message" && item.phase === "final_answer" && item.text);
  const quality = status === "completed" && hasUser && hasFinal ? "complete" : status === "interrupted" ? "interrupted" : "partial";
  const startedAt = timestamp(raw.startedAt);
  const completedAt = timestamp(raw.completedAt);
  return {
    id: raw.id, status, quality,
    ...(startedAt ? { startedAt } : {}), ...(completedAt ? { completedAt } : {}), items,
  };
}

export function normalizeCodexThread(thread: unknown, turns: unknown[] = []): ConversationThread {
  const raw = record(thread);
  if (!raw || typeof raw.id !== "string" || typeof raw.cwd !== "string") throw new Error("Codex app-server returned an invalid thread");
  const normalizedTurns = turns.map(normalizeTurn).filter((turn): turn is ConversationTurn => Boolean(turn));
  const createdAt = timestamp(raw.createdAt) ?? new Date(0).toISOString();
  const updatedAt = timestamp(raw.updatedAt) ?? createdAt;
  const preview = typeof raw.preview === "string" && raw.preview.trim()
    ? raw.preview
    : normalizedTurns.flatMap((turn) => turn.items).find((item) => item.type === "user_message" && item.text)?.text ?? "Codex conversation";
  return {
    source: "codex", id: raw.id, sessionId: string(raw.sessionId) ?? raw.id, cwd: raw.cwd,
    cliVersion: string(raw.cliVersion) ?? "unknown", ephemeral: raw.ephemeral === true,
    createdAt, updatedAt, preview, turns: normalizedTurns,
  };
}

function pageData(value: unknown): { data: unknown[]; nextCursor?: string } {
  if (Array.isArray(value)) return { data: value };
  const raw = record(value);
  return {
    data: Array.isArray(raw?.data) ? raw.data : [],
    nextCursor: typeof raw?.nextCursor === "string" ? raw.nextCursor : undefined,
  };
}

export function codexHooksPath(env: NodeJS.ProcessEnv = process.env): string {
  const home = env.CODEX_HOME || `${env.HOME || ""}/.codex`;
  return `${home.replace(/\/$/u, "")}/hooks.json`;
}

export function probeCodexCapture(env: NodeJS.ProcessEnv = process.env): CodexCaptureCapabilities {
  const binary = findExecutable(["codex"], env);
  const hooksPath = codexHooksPath(env);
  if (!binary) return { available: false, binary: null, version: null, appServer: false, hooksPath, captureModes: [], detail: "Codex executable not found" };
  const version = spawnSync(binary, ["--version"], { env, encoding: "utf8", timeout: 10_000 });
  const help = spawnSync(binary, ["app-server", "--help"], { env, encoding: "utf8", timeout: 10_000 });
  const appServer = help.status === 0;
  return {
    available: true, binary,
    version: [version.stdout, version.stderr].filter(Boolean).join(" ").trim() || null,
    appServer, hooksPath,
    captureModes: appServer ? ["app_server", "hook"] : ["hook"],
    ...(appServer ? {} : { detail: "This Codex installation does not expose app-server" }),
  };
}

export class CodexAppServerCaptureAdapter implements CaptureAdapter {
  readonly id = "codex";
  private process: ChildProcessWithoutNullStreams | null = null;
  private nextId = 1;
  private readonly pending = new Map<number, PendingRequest>();
  private readonly requestTimeoutMs: number;

  constructor(
    private readonly binary: string,
    private readonly env: NodeJS.ProcessEnv = process.env,
    options: CodexAppServerClientOptions = {},
  ) {
    this.requestTimeoutMs = options.requestTimeoutMs ?? 15_000;
  }

  async connect(): Promise<void> {
    if (this.process) return;
    const child = spawn(this.binary, ["app-server", "--stdio"], { env: this.env, stdio: ["pipe", "pipe", "pipe"] });
    this.process = child;
    child.once("exit", (code) => this.failAll(new Error(`Codex app-server exited with code ${code ?? "unknown"}`)));
    child.once("error", (error) => this.failAll(error));
    child.stderr.resume();
    createInterface({ input: child.stdout }).on("line", (line) => this.handleLine(line));
    await this.request("initialize", { clientInfo: { name: "open_continuity", title: "OpenContinuity", version: "1" } });
    this.notify("initialized", {});
  }

  async listThreads(input: { pageSize?: number; maxThreads?: number } = {}): Promise<CaptureListResult> {
    const pageSize = input.pageSize ?? 20;
    const maxThreads = input.maxThreads ?? 100;
    const threads: RecordValue[] = [];
    let cursor: string | undefined;
    let pages = 0;
    do {
      const page = pageData(await this.request("thread/list", {
        limit: Math.min(pageSize, Math.max(1, maxThreads - threads.length)),
        ...(cursor ? { cursor } : {}), sortKey: "updated_at", sortDirection: "desc", archived: false,
      }));
      pages += 1;
      for (const value of page.data) {
        const thread = record(value);
        if (thread) threads.push(thread);
      }
      cursor = page.nextCursor;
    } while (cursor && threads.length < maxThreads);
    const references: CaptureThreadReference[] = threads.slice(0, maxThreads).flatMap((thread) => {
      if (typeof thread.id !== "string" || typeof thread.cwd !== "string") return [];
      return [{ id: thread.id, cwd: thread.cwd, updatedAt: timestamp(thread.updatedAt) ?? new Date(0).toISOString(), ephemeral: thread.ephemeral === true }];
    });
    return { threads: references, pages, truncated: Boolean(cursor) };
  }

  async readThread(threadId: string): Promise<ConversationThread> {
    const result = record(await this.request("thread/read", { threadId, includeTurns: false }));
    const thread = result?.thread;
    let turns: unknown[] = [];
    try {
      const page = pageData(await this.request("thread/turns/list", { threadId, limit: 1000, sortDirection: "asc", itemsView: "full" }));
      turns = page.data;
    } catch {
      // Older app-server builds only expose full-history hydration.
      const legacy = record(await this.request("thread/read", { threadId, includeTurns: true }));
      const legacyThread = record(legacy?.thread);
      turns = Array.isArray(legacyThread?.turns) ? legacyThread.turns : [];
    }
    return normalizeCodexThread(thread, turns);
  }

  async close(): Promise<void> {
    const child = this.process;
    this.process = null;
    this.failAll(new Error("Codex app-server connection closed"));
    if (child && !child.killed) child.kill("SIGTERM");
  }

  private request(method: string, params: unknown): Promise<unknown> {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Codex app-server request timed out: ${method}`));
      }, this.requestTimeoutMs);
      this.pending.set(id, { resolve, reject, timeout });
      this.write({ id, method, params });
    });
  }

  private notify(method: string, params: unknown): void { this.write({ method, params }); }

  private write(message: unknown): void {
    if (!this.process) throw new Error("Codex app-server is not connected");
    this.process.stdin.write(JSON.stringify(message) + "\n");
  }

  private handleLine(line: string): void {
    let response: JsonRpcResponse;
    try { response = JSON.parse(line) as JsonRpcResponse; } catch { return; }
    if (typeof response.id !== "number") return;
    const pending = this.pending.get(response.id);
    if (!pending) return;
    clearTimeout(pending.timeout);
    this.pending.delete(response.id);
    if (response.error) pending.reject(new Error(response.error.message || "Codex app-server request failed"));
    else pending.resolve(response.result);
  }

  private failAll(error: Error): void {
    for (const pending of this.pending.values()) { clearTimeout(pending.timeout); pending.reject(error); }
    this.pending.clear();
  }
}
