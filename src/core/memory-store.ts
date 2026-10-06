import { closeSync, existsSync, mkdirSync, openSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname } from "node:path";
import { randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { OpenContinuityError } from "../shared/errors.js";
import { evolutionReceipt, evolutionReceiptFromEvent, resolveEvolution, sameEvolutionRequest } from "./evolution.js";
import { decodeCursor, encodeCursor } from "./cursor.js";
import type { HistoryResult, MemoryEvent, ParsedHistoryInput, ParsedRecallInput, ParsedRememberInput, RecallResult, ResolvedMemory } from "../shared/types.js";

export interface MemoryStore {
  appendRemember(input: ParsedRememberInput): MemoryReceiptLike | Promise<MemoryReceiptLike>;
  appendForget(userId: string, agentId: string, memoryId: string, taskId?: string, includePrivate?: boolean): MemoryReceiptLike | Promise<MemoryReceiptLike>;
  recall(input: ParsedRecallInput): RecallResult | Promise<RecallResult>;
  history(input: ParsedHistoryInput): HistoryResult | Promise<HistoryResult>;
  close?(): void | Promise<void>;
}
export interface MemoryReceiptLike { event: MemoryEvent; duplicate: boolean; current: ResolvedMemory; evolution?: import("../shared/types.js").MemoryEvolutionReceipt; }
function now(): string { return new Date().toISOString(); }
function memoryKey(input: { scope: ParsedRememberInput["scope"]; key: string; taskId?: string; agentId?: string; ownerAgentId?: string }): string {
  if (input.scope === "task") return "task:" + input.taskId + ":" + input.key;
  if (input.scope === "agent") return "agent:" + (input.ownerAgentId || input.agentId) + ":" + input.key;
  return "user:-:" + input.key;
}
function idempotencyKey(userId: string, requestKey: string): string { return userId + ":" + requestKey; }
function sameRememberRequest(event: MemoryEvent, input: ParsedRememberInput): boolean {
  return event.userId === input.userId && event.agentId === input.agentId && event.key === input.key && event.kind === input.kind
    && event.scope === (input.scope || "user") && event.taskId === input.taskId && event.sensitivity === (input.sensitivity || "public")
    && event.userConfirmed === (input.userConfirmed || false) && sameEvolutionRequest(event, input)
    && isDeepStrictEqual(event.metadata, input.metadata)
}

export class InMemoryStore implements MemoryStore {
  private readonly events: MemoryEvent[] = [];
  private readonly resolved = new Map<string, ResolvedMemory>();
  private readonly idempotency = new Map<string, MemoryReceiptLike>();

  constructor(initialEvents: MemoryEvent[] = []) {
    for (const event of initialEvents) this.applyEvent(event);
  }

  allEvents(): MemoryEvent[] {
    return [...this.events];
  }

  appendRemember(input: ParsedRememberInput): MemoryReceiptLike {
    const scopedIdempotencyKey = idempotencyKey(input.userId, input.idempotencyKey);
    const duplicate = this.idempotency.get(scopedIdempotencyKey);
    if (duplicate) {
      if (!sameRememberRequest(duplicate.event, input)) throw new OpenContinuityError("IDEMPOTENCY_CONFLICT", "Idempotency key was already used for a different request", 409, { idempotencyKey: input.idempotencyKey });
      return { ...duplicate, duplicate: true };
    }
    const mapKey = input.userId + ":" + memoryKey(input);
    const previous = this.resolved.get(mapKey);
    const resolution = resolveEvolution(previous, input);
    const id = previous?.id || randomUUID();
    const event: MemoryEvent = { id: randomUUID(), userId: input.userId, agentId: input.agentId, type: "memory_remembered", memoryId: id, key: input.key, value: resolution.value, inputValue: input.value, kind: input.kind, scope: input.scope, taskId: input.taskId, sensitivity: input.sensitivity, userConfirmed: input.userConfirmed, idempotencyKey: input.idempotencyKey, createdAt: now(), metadata: input.metadata, memoryVersion: resolution.version, evolutionAction: resolution.action, writeMode: input.writeMode, expectedVersion: input.expectedVersion, supersedes: resolution.supersedes, confidence: resolution.confidence };
    const current: ResolvedMemory = { id, key: input.key, value: resolution.value, kind: input.kind, scope: input.scope, taskId: input.taskId, ownerAgentId: input.scope === "agent" ? input.agentId : undefined, sensitivity: input.sensitivity, userConfirmed: input.userConfirmed, sourceEventId: event.id, sourceAgentId: input.agentId, updatedAt: event.createdAt, version: resolution.version, supersedes: resolution.supersedes, confidence: resolution.confidence };
    this.events.push(event); this.resolved.set(mapKey, current);
    const receipt = { event, duplicate: false, current, evolution: evolutionReceipt(input, resolution) }; this.idempotency.set(idempotencyKey(input.userId, input.idempotencyKey), receipt); return receipt;
  }

  appendForget(userId: string, agentId: string, memoryId: string, taskId?: string, includePrivate = false): MemoryReceiptLike {
    const current = Array.from(this.resolved.values()).find((memory) => memory.id === memoryId && this.belongsToUser(memory, userId) && this.isVisible(memory, agentId, taskId) && (includePrivate || memory.sensitivity !== "private"));
    if (!current) throw new OpenContinuityError("MEMORY_NOT_FOUND", "Memory not found", 404, { memoryId });
    const event: MemoryEvent = { id: randomUUID(), userId, agentId, type: "memory_forgotten", memoryId, key: current.key, kind: current.kind, scope: current.scope, taskId: current.taskId, sensitivity: current.sensitivity, userConfirmed: true, idempotencyKey: "forget:" + memoryId + ":" + Date.now(), createdAt: now(), metadata: {}, memoryVersion: current.version };
    this.events.push(event); this.resolved.delete(userId + ":" + memoryKey(current)); return { event, duplicate: false, current };
  }

  recall(input: ParsedRecallInput): RecallResult {
    const cursor = decodeCursor(input.cursor, "memory");
    const matches = Array.from(this.resolved.values()).filter((memory) => {
      if (!this.belongsToUser(memory, input.userId) || !this.isVisible(memory, input.agentId, input.taskId)) return false;
      if (!input.includePrivate && memory.sensitivity === "private") return false;
      if (input.scope && memory.scope !== input.scope) return false;
      if (input.key && memory.key !== input.key) return false;
      if (input.kind && memory.kind !== input.kind) return false;
      return !input.query || (memory.key + " " + JSON.stringify(memory.value)).toLowerCase().includes(input.query.toLowerCase());
    }).sort((left, right) => right.updatedAt.localeCompare(left.updatedAt) || right.id.localeCompare(left.id));
    const afterCursor = cursor ? matches.filter((memory) => memory.updatedAt < cursor.timestamp || (memory.updatedAt === cursor.timestamp && memory.id < cursor.id)) : matches;
    const page = afterCursor.slice(0, input.limit + 1);
    const hasMore = page.length > input.limit;
    const memories = hasMore ? page.slice(0, input.limit) : page;
    const last = memories.at(-1);
    return { memories, nextCursor: hasMore && last ? encodeCursor("memory", last.updatedAt, last.id) : null };
  }
  history(input: ParsedHistoryInput): HistoryResult {
    const cursor = decodeCursor(input.cursor, "event");
    const matches = this.events.filter((event) => {
      if (event.userId !== input.userId || (input.memoryId && event.memoryId !== input.memoryId)) return false;
      if (!input.includePrivate && event.sensitivity === "private") return false;
      if (event.scope === "agent" && event.agentId !== input.agentId) return false;
      if (event.scope === "task" && (!input.taskId || event.taskId !== input.taskId)) return false;
      return true;
    }).sort((left, right) => right.createdAt.localeCompare(left.createdAt) || right.id.localeCompare(left.id));
    const afterCursor = cursor ? matches.filter((event) => event.createdAt < cursor.timestamp || (event.createdAt === cursor.timestamp && event.id < cursor.id)) : matches;
    const page = afterCursor.slice(0, input.limit + 1);
    const hasMore = page.length > input.limit;
    const events = hasMore ? page.slice(0, input.limit) : page;
    const last = events.at(-1);
    return { events, nextCursor: hasMore && last ? encodeCursor("event", last.createdAt, last.id) : null };
  }
  private belongsToUser(memory: ResolvedMemory, userId: string): boolean { return this.events.some((event) => event.userId === userId && event.id === memory.sourceEventId); }
  private isVisible(memory: ResolvedMemory, agentId: string, taskId?: string): boolean {
    if (memory.scope === "agent") return memory.ownerAgentId === agentId;
    if (memory.scope === "task") return Boolean(taskId) && memory.taskId === taskId;
    return true;
  }

  private applyEvent(event: MemoryEvent): void {
    this.events.push(event);
    if (event.type === "memory_forgotten") {
      const current = Array.from(this.resolved.values()).find((memory) => memory.id === event.memoryId && this.belongsToUser(memory, event.userId));
      if (current) this.resolved.delete(event.userId + ":" + memoryKey(current));
      return;
    }
    const mapKey = event.userId + ":" + memoryKey(event);
    const previous = this.resolved.get(mapKey);
    const current: ResolvedMemory = {
      id: event.memoryId, key: event.key, value: event.value, kind: event.kind, scope: event.scope, taskId: event.taskId, ownerAgentId: event.scope === "agent" ? event.agentId : undefined,
      sensitivity: event.sensitivity, userConfirmed: event.userConfirmed, sourceEventId: event.id, sourceAgentId: event.agentId,
      updatedAt: event.createdAt, version: event.memoryVersion ?? (previous?.version || 0) + 1, supersedes: event.supersedes, confidence: event.confidence,
    };
    this.resolved.set(mapKey, current);
    this.idempotency.set(idempotencyKey(event.userId, event.idempotencyKey), { event, duplicate: false, current, evolution: evolutionReceiptFromEvent(event, current) });
  }
}

/**
 * A small local event ledger for separate MCP stdio processes. It is intended
 * for a single machine prototype; a database-backed store should replace it
 * when multiple machines or high write concurrency are needed.
 */
export class JsonFileStore implements MemoryStore {
  private current: InMemoryStore;
  private readonly lockWaitMs = 5000;

  constructor(private readonly filePath = homedir() + "/.open-continuity/memories.json") {
    this.current = new InMemoryStore(this.readEvents());
  }

  appendRemember(input: ParsedRememberInput): MemoryReceiptLike {
    return this.withWriteLock(() => this.current.appendRemember(input));
  }

  appendForget(userId: string, agentId: string, memoryId: string, taskId?: string, includePrivate?: boolean): MemoryReceiptLike {
    return this.withWriteLock(() => this.current.appendForget(userId, agentId, memoryId, taskId, includePrivate));
  }

  recall(input: ParsedRecallInput): RecallResult {
    this.refresh();
    return this.current.recall(input);
  }

  history(input: ParsedHistoryInput): HistoryResult {
    this.refresh();
    return this.current.history(input);
  }

  private refresh(): void {
    this.current = new InMemoryStore(this.readEvents());
  }

  private readEvents(): MemoryEvent[] {
    if (!existsSync(this.filePath)) return [];
    try {
      const raw = JSON.parse(readFileSync(this.filePath, "utf8")) as { events?: unknown };
      if (!Array.isArray(raw.events)) throw new Error("events must be an array");
      return raw.events as MemoryEvent[];
    } catch (error) {
      if (error instanceof OpenContinuityError) throw error;
      throw new OpenContinuityError("STORAGE_ERROR", "Unable to read the memory store", 500);
    }
  }

  private persist(): void {
    mkdirSync(dirname(this.filePath), { recursive: true });
    const temporaryPath = this.filePath + "." + process.pid + "." + randomUUID() + ".tmp";
    try {
      writeFileSync(temporaryPath, JSON.stringify({ events: this.current.allEvents() }, null, 2) + "\n", "utf8");
      renameSync(temporaryPath, this.filePath);
    } finally {
      if (existsSync(temporaryPath)) unlinkSync(temporaryPath);
    }
  }

  private withWriteLock<T>(operation: () => T): T {
    mkdirSync(dirname(this.filePath), { recursive: true });
    const lockPath = this.filePath + ".lock";
    const startedAt = Date.now();
    let lockFd: number | undefined;
    while (lockFd === undefined) {
      try {
        lockFd = openSync(lockPath, "wx");
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST" || Date.now() - startedAt >= this.lockWaitMs) throw error;
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
      }
    }
    try {
      this.refresh();
      const result = operation();
      this.persist();
      return result;
    } finally {
      closeSync(lockFd);
      unlinkSync(lockPath);
    }
  }
}
