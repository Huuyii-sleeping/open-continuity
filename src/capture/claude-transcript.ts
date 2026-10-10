import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { createInterface } from "node:readline";
import type { CaptureAdapter, CaptureListResult } from "../adapters/contracts.js";
import { isWorkspaceAllowed } from "../cli/config.js";
import type { ConversationItem, ConversationThread, ConversationTurn } from "./types.js";

type UnknownRecord = Record<string, unknown>;

export interface ClaudeStopHookInput {
  session_id: string;
  prompt_id?: string;
  transcript_path: string;
  cwd: string;
  hook_event_name?: string;
  last_assistant_message?: string;
  stop_hook_active?: boolean;
  [key: string]: unknown;
}

interface MutableTurn {
  id: string;
  startedAt?: string;
  completedAt?: string;
  items: ConversationItem[];
}

interface TranscriptMetadata {
  sessionId?: string;
  cliVersion?: string;
  createdAt?: string;
  latestAt?: string;
}

function record(value: unknown): UnknownRecord | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? value as UnknownRecord : undefined;
}

function string(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value : undefined;
}

function timestamp(value: unknown): string | undefined {
  if (typeof value !== "string" && typeof value !== "number") return undefined;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? undefined : date.toISOString();
}

function stableId(prefix: string, ...parts: unknown[]): string {
  return `${prefix}-${createHash("sha256").update(parts.map((part) => String(part ?? "")).join("\0")).digest("hex").slice(0, 20)}`;
}

function compactText(text: string): string {
  return text.trim().replace(/\r\n/g, "\n");
}

function comparisonText(text: string): string {
  return compactText(text).replace(/\s+/gu, " ");
}

function injectedContext(text: string): boolean {
  const normalized = text.trim();
  return normalized.includes("<open-continuity-memory-context>")
    || normalized.startsWith("<system-reminder>")
    || normalized.startsWith("<local-command-caveat>");
}

function textContent(value: unknown): string {
  if (typeof value === "string") return value;
  if (!Array.isArray(value)) return "";
  return value.flatMap((entry) => {
    const block = record(entry);
    if (!block) return [];
    const text = string(block.text) ?? string(block.content);
    return text ? [text] : [];
  }).join("\n");
}

function contentBlocks(message: UnknownRecord | undefined): unknown[] {
  if (!message) return [];
  return Array.isArray(message.content) ? message.content : message.content == null ? [] : [message.content];
}

function updateMetadata(metadata: TranscriptMetadata, raw: UnknownRecord): void {
  metadata.sessionId ??= string(raw.sessionId) ?? string(raw.session_id);
  metadata.cliVersion = string(raw.version) ?? metadata.cliVersion;
  const at = timestamp(raw.timestamp) ?? timestamp(raw.createdAt) ?? timestamp(raw.updatedAt);
  if (!at) return;
  if (!metadata.createdAt || at < metadata.createdAt) metadata.createdAt = at;
  if (!metadata.latestAt || at > metadata.latestAt) metadata.latestAt = at;
}

function userText(raw: UnknownRecord, message: UnknownRecord | undefined): string {
  if (raw.isMeta === true || raw.isSidechain === true) return "";
  const texts = contentBlocks(message).flatMap((entry) => {
    if (typeof entry === "string") return [entry];
    const block = record(entry);
    return block?.type === "text" && typeof block.text === "string" ? [block.text] : [];
  }).map(compactText).filter((text) => text && !injectedContext(text));
  return texts.join("\n");
}

function finalizeTurns(turns: MutableTurn[]): ConversationTurn[] {
  return turns.filter((turn) => turn.items.length > 0).map((turn) => {
    const assistantIndexes = turn.items.flatMap((item, index) => item.type === "assistant_message" && item.text ? [index] : []);
    const finalIndex = assistantIndexes.at(-1);
    for (const index of assistantIndexes) turn.items[index] = { ...turn.items[index], phase: index === finalIndex ? "final_answer" : "commentary" };
    const hasUser = turn.items.some((item) => item.type === "user_message" && item.text);
    const hasFinal = finalIndex != null;
    return {
      id: turn.id,
      status: hasFinal ? "completed" : "unknown",
      quality: hasUser && hasFinal ? "complete" : "partial",
      ...(turn.startedAt ? { startedAt: turn.startedAt } : {}),
      ...(turn.completedAt ? { completedAt: turn.completedAt } : {}),
      items: turn.items,
    };
  });
}

export function normalizeClaudeTranscript(
  lines: Iterable<string>,
  input: ClaudeStopHookInput,
  observedAt = new Date().toISOString(),
  allowedWorkspaces: string[] = [],
): ConversationThread {
  const turns: MutableTurn[] = [];
  const metadata: TranscriptMetadata = {};
  const toolNames = new Map<string, string>();
  let current: MutableTurn | undefined;
  let validRecords = 0;
  let lastAssistantRecordText = "";

  const ensureTurn = (seed: string, at?: string): MutableTurn => {
    if (!current) {
      current = { id: stableId("claude-turn", input.session_id, seed), ...(at ? { startedAt: at } : {}), items: [] };
      turns.push(current);
    }
    return current;
  };

  for (const line of lines) {
    if (!line.trim()) continue;
    let raw: UnknownRecord;
    try {
      const parsed = record(JSON.parse(line));
      if (!parsed) continue;
      raw = parsed;
    } catch {
      // Claude writes transcripts asynchronously. A partially written trailing
      // JSON line must not make the completed turn disappear.
      continue;
    }
    const entryCwd = string(raw.cwd);
    if (entryCwd && allowedWorkspaces.length > 0 && !isWorkspaceAllowed(allowedWorkspaces, entryCwd)) continue;
    validRecords += 1;
    updateMetadata(metadata, raw);
    if (raw.isSidechain === true) continue;
    const type = string(raw.type) ?? "unknown";
    const message = record(raw.message);
    const entryId = string(raw.uuid) ?? string(raw.id) ?? stableId("claude-entry", input.session_id, validRecords, line);
    const at = timestamp(raw.timestamp) ?? timestamp(raw.createdAt);

    if (type === "user") {
      const prompt = userText(raw, message);
      if (prompt) {
        current = { id: entryId, ...(at ? { startedAt: at } : {}), items: [{
          id: `${entryId}:user`, type: "user_message", text: prompt, rawType: "claude:user",
        }] };
        turns.push(current);
      }
      for (const [index, entry] of contentBlocks(message).entries()) {
        const block = record(entry);
        if (block?.type !== "tool_result") continue;
        const toolUseId = string(block.tool_use_id) ?? stableId("claude-tool", entryId, index);
        const output = compactText(textContent(block.content)) || "[non-text tool result omitted]";
        ensureTurn(entryId, at).items.push({
          id: `${entryId}:tool-result:${toolUseId}`, type: "tool_call", toolName: toolNames.get(toolUseId),
          toolOutput: output, toolStatus: block.is_error === true ? "failed" : "completed", rawType: "claude:tool_result",
        });
      }
      continue;
    }

    if (type === "assistant") {
      const turn = ensureTurn(entryId, at);
      const recordTexts: string[] = [];
      for (const [index, entry] of contentBlocks(message).entries()) {
        if (typeof entry === "string") {
          const text = compactText(entry);
          if (text) {
            recordTexts.push(text);
            turn.items.push({ id: `${entryId}:assistant:${index}`, type: "assistant_message", text, phase: "commentary", rawType: "claude:assistant" });
          }
          continue;
        }
        const block = record(entry);
        if (!block) continue;
        if (block.type === "text" && typeof block.text === "string") {
          const text = compactText(block.text);
          if (text) {
            recordTexts.push(text);
            turn.items.push({ id: `${entryId}:assistant:${index}`, type: "assistant_message", text, phase: "commentary", rawType: "claude:assistant" });
          }
        } else if (block.type === "tool_use") {
          const toolUseId = string(block.id) ?? stableId("claude-tool", entryId, index);
          const toolName = string(block.name);
          if (toolName) toolNames.set(toolUseId, toolName);
          turn.items.push({
            id: `${entryId}:tool-use:${toolUseId}`, type: "tool_call", toolName,
            toolInput: block.input, toolStatus: "requested", rawType: "claude:tool_use",
          });
        }
      }
      if (recordTexts.length) lastAssistantRecordText = recordTexts.join("\n");
      if (at) turn.completedAt = at;
      continue;
    }

    if (type === "system" && (raw.subtype === "compact_boundary" || raw.subtype === "compact")) {
      ensureTurn(entryId, at).items.push({ id: `${entryId}:compaction`, type: "compaction", rawType: "claude:compaction" });
    }
  }

  const lastAssistant = compactText(input.last_assistant_message ?? "");
  if (lastAssistant) {
    const turn = ensureTurn(input.prompt_id || "stop", observedAt);
    const existing = turn.items.filter((item) => item.type === "assistant_message" && item.text).at(-1);
    if ((!existing || comparisonText(existing.text!) !== comparisonText(lastAssistant))
      && comparisonText(lastAssistantRecordText) !== comparisonText(lastAssistant)) {
      turn.items.push({
        id: stableId("claude-stop", input.session_id, input.prompt_id, lastAssistant), type: "assistant_message",
        text: lastAssistant, phase: "final_answer", rawType: "claude:stop:last_assistant_message",
      });
    }
    turn.completedAt = observedAt;
  }

  const normalizedTurns = finalizeTurns(turns);
  const createdAt = metadata.createdAt ?? normalizedTurns[0]?.startedAt ?? observedAt;
  const preview = normalizedTurns.flatMap((turn) => turn.items)
    .find((item) => item.type === "user_message" && item.text)?.text?.slice(0, 240) ?? "Claude Code conversation";
  return {
    source: "claude",
    id: input.session_id,
    sessionId: metadata.sessionId ?? input.session_id,
    cwd: input.cwd,
    cliVersion: metadata.cliVersion ?? "unknown",
    ephemeral: false,
    createdAt,
    updatedAt: observedAt,
    preview,
    turns: normalizedTurns,
  };
}

export class ClaudeTranscriptCaptureAdapter implements CaptureAdapter {
  readonly id = "claude";
  private connected = false;
  private lines: string[] | undefined;

  constructor(
    private readonly input: ClaudeStopHookInput,
    private readonly observedAt = new Date().toISOString(),
    private readonly allowedWorkspaces: string[] = [],
  ) {}

  async connect(): Promise<void> {
    if (this.connected) return;
    const lines: string[] = [];
    const reader = createInterface({ input: createReadStream(this.input.transcript_path, { encoding: "utf8" }), crlfDelay: Infinity });
    for await (const line of reader) lines.push(line);
    this.lines = lines;
    this.connected = true;
  }

  async listThreads(): Promise<CaptureListResult> {
    return {
      threads: [{ id: this.input.session_id, cwd: this.input.cwd, updatedAt: this.observedAt, ephemeral: false }],
      pages: 1,
      truncated: false,
    };
  }

  async readThread(threadId: string): Promise<ConversationThread> {
    if (!this.connected || !this.lines) throw new Error("Claude transcript Adapter is not connected");
    if (threadId !== this.input.session_id) throw new Error(`Claude transcript session not found: ${threadId}`);
    return normalizeClaudeTranscript(this.lines, this.input, this.observedAt, this.allowedWorkspaces);
  }

  async close(): Promise<void> {
    this.lines = undefined;
    this.connected = false;
  }
}
