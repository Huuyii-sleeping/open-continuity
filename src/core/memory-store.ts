import { closeSync, existsSync, mkdirSync, openSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname } from "node:path";
import { randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { OpenContinuityError } from "../shared/errors.js";
import { evolutionReceipt, evolutionReceiptFromEvent, resolveEvolution, sameEvolutionRequest } from "./evolution.js";
import { decodeCursor, encodeCursor } from "./cursor.js";
import { memoryEventSchema, type HistoryResult, type MemoryEvent, type ParsedHistoryInput, type ParsedRecallInput, type ParsedRememberInput, type RecallResult, type ResolvedMemory } from "../shared/types.js";
import { assertStructuredInput, memoryIdentity, storedMemoryIdentity, storageFingerprint, type LegacyMemoryLookup, type MemoryPersistence, type MemoryRepository, type StructuredMemoryInput } from "./storage-contract.js";
import { candidateQuery, exactCandidateKey, parseCandidateSearch, skippedCandidates, unscoredCandidate, type CandidateSearchRequest, type CandidateSearchResult, type CandidateSearchStore } from "./candidate-search.js";
import { matchesFactGroup, parseFactGroupRequest, type FactGroupRequest, type FactGroupStore } from "./fact-store.js";
import { decodeEventLedger, encodeEventLedger } from "./event-ledger.js";

export interface MemoryStore extends MemoryPersistence, LegacyMemoryLookup {
  // Optional on legacy/custom implementations; concrete stores implement MemoryRepository.
  list?: MemoryRepository["list"];
  // Staged phase-2 API; legacy/custom stores need not claim this capability.
  searchCandidates?: CandidateSearchStore["searchCandidates"];
  readFactGroup?: FactGroupStore["readFactGroup"];
}
export interface MemoryReceiptLike { event: MemoryEvent; duplicate: boolean; current: ResolvedMemory; evolution?: import("../shared/types.js").MemoryEvolutionReceipt; }
function now(): string { return new Date().toISOString(); }
function idempotencyKey(userId: string, requestKey: string): string { return JSON.stringify([userId, requestKey]); }
function sameRememberRequest(event: MemoryEvent, input: ParsedRememberInput): boolean {
  return event.type === "memory_remembered" && event.userId === input.userId && event.agentId === input.agentId && event.key === input.key && event.kind === input.kind
    && event.scope === (input.scope || "user") && event.taskId === input.taskId && event.sensitivity === (input.sensitivity || "public")
    && event.userConfirmed === (input.userConfirmed || false) && sameEvolutionRequest(event, input)
    && isDeepStrictEqual(event.metadata, input.metadata)
}

export class InMemoryStore implements MemoryStore, MemoryRepository, CandidateSearchStore {
  private readonly events: MemoryEvent[] = [];
  private readonly resolved = new Map<string, ResolvedMemory>();
  private readonly idempotency = new Map<string, MemoryReceiptLike>();
  private readonly eventOwners = new Map<string, string>();

  constructor(initialEvents: MemoryEvent[] = []) {
    for (const event of initialEvents) this.applyEvent(memoryEventSchema.parse(structuredClone(event)));
  }

  allEvents(): MemoryEvent[] {
    return structuredClone(this.events);
  }

  appendRemember(input: ParsedRememberInput): MemoryReceiptLike {
    input = structuredClone(input);
    const scopedIdempotencyKey = idempotencyKey(input.userId, input.idempotencyKey);
    const duplicate = this.idempotency.get(scopedIdempotencyKey);
    if (duplicate) {
      if (!sameRememberRequest(duplicate.event, input)) throw new OpenContinuityError("IDEMPOTENCY_CONFLICT", "Idempotency key was already used for a different request", 409, { idempotencyKey: input.idempotencyKey });
      return structuredClone({ ...duplicate, duplicate: true });
    }
    const mapKey = memoryIdentity(input);
    const previous = this.resolved.get(mapKey);
    const resolution = resolveEvolution(previous, input);
    const id = previous?.id || randomUUID();
    const event: MemoryEvent = { id: randomUUID(), userId: input.userId, agentId: input.agentId, type: "memory_remembered", memoryId: id, key: input.key, value: resolution.value, inputValue: input.value, kind: input.kind, scope: input.scope, taskId: input.taskId, sensitivity: input.sensitivity, userConfirmed: input.userConfirmed, idempotencyKey: input.idempotencyKey, createdAt: now(), metadata: input.metadata, memoryVersion: resolution.version, evolutionAction: resolution.action, writeMode: input.writeMode, expectedVersion: input.expectedVersion, supersedes: resolution.supersedes, confidence: resolution.confidence, fact: input.fact };
    const current: ResolvedMemory = { id, key: input.key, value: resolution.value, kind: input.kind, scope: input.scope, taskId: input.taskId, ownerAgentId: input.scope === "agent" ? input.agentId : undefined, sensitivity: input.sensitivity, userConfirmed: input.userConfirmed, sourceEventId: event.id, sourceAgentId: input.agentId, updatedAt: event.createdAt, version: resolution.version, supersedes: resolution.supersedes, confidence: resolution.confidence, fact: input.fact };
    this.events.push(event); this.resolved.set(mapKey, current);
    this.eventOwners.set(event.id, input.userId);
    const receipt = { event, duplicate: false, current, evolution: evolutionReceipt(input, resolution) }; this.idempotency.set(idempotencyKey(input.userId, input.idempotencyKey), receipt); return structuredClone(receipt);
  }

  appendForget(userId: string, agentId: string, memoryId: string, taskId?: string, includePrivate = false): MemoryReceiptLike {
    const current = Array.from(this.resolved.values()).find((memory) => memory.id === memoryId && this.belongsToUser(memory, userId) && this.isVisible(memory, agentId, taskId) && (includePrivate || memory.sensitivity !== "private"));
    if (!current) throw new OpenContinuityError("MEMORY_NOT_FOUND", "Memory not found", 404, { memoryId });
    const event: MemoryEvent = { id: randomUUID(), userId, agentId, type: "memory_forgotten", memoryId, key: current.key, kind: current.kind, scope: current.scope, taskId: current.taskId, sensitivity: current.sensitivity, userConfirmed: true, idempotencyKey: "forget:" + memoryId + ":" + randomUUID(), createdAt: now(), metadata: {}, memoryVersion: current.version };
    this.events.push(event); this.eventOwners.set(event.id, userId); this.resolved.delete(storedMemoryIdentity(userId, current));
    const receipt = { event, duplicate: false, current };
    this.idempotency.set(idempotencyKey(userId, event.idempotencyKey), receipt);
    return structuredClone(receipt);
  }

  list(input: StructuredMemoryInput): RecallResult { assertStructuredInput(input); return this.read(input); }
  recall(input: ParsedRecallInput): RecallResult {
    return input.query === undefined ? this.list(input as StructuredMemoryInput) : this.read(input);
  }
  private read(input: ParsedRecallInput): RecallResult {
    const fingerprint = storageFingerprint(input, "memory");
    const cursor = decodeCursor(input.cursor, "memory", fingerprint);
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
    return { memories: structuredClone(memories), nextCursor: hasMore && last ? encodeCursor("memory", last.updatedAt, last.id, fingerprint) : null };
  }
  searchCandidates(request: CandidateSearchRequest): CandidateSearchResult {
    const input = parseCandidateSearch(request), skipped = skippedCandidates(input);
    if (skipped) return skipped;
    const query = candidateQuery(input).toLowerCase();
    const rows = Array.from(this.resolved.values()).filter(memory => {
      if (!this.belongsToUser(memory, input.userId) || !this.isVisible(memory, input.agentId, input.taskId)) return false;
      if ((!input.includePrivate && memory.sensitivity === "private") || (input.requireUserConfirmed && !memory.userConfirmed)) return false;
      if ((input.scope && memory.scope !== input.scope) || (input.kind && memory.kind !== input.kind) || (input.key && memory.key !== input.key)) return false;
      if (input.channel === "exact") return memory.key === exactCandidateKey(input);
      if (input.channel === "full_text") return memory.key.toLowerCase().includes(query) || JSON.stringify(memory.value).toLowerCase().includes(query);
      return true;
    }).sort((a,b) => b.updatedAt.localeCompare(a.updatedAt) || b.id.localeCompare(a.id));
    return { channel: input.channel, status: "ok", hits: structuredClone(rows.slice(0,input.limit)).map((memory,index) => unscoredCandidate(memory,input,index)),
      truncated: rows.length > input.limit, ordering: "updated_at_id", implementation: input.channel === "full_text" ? "inmemory_compatibility" : "structured_lookup" };
  }
  history(input: ParsedHistoryInput): HistoryResult {
    const fingerprint = storageFingerprint(input, "event");
    const cursor = decodeCursor(input.cursor, "event", fingerprint);
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
    return { events: structuredClone(events), nextCursor: hasMore && last ? encodeCursor("event", last.createdAt, last.id, fingerprint) : null };
  }
  readFactGroup(request: FactGroupRequest) {
    const input = parseFactGroupRequest(request);
    const rows = Array.from(this.resolved.values()).filter(memory => this.belongsToUser(memory, input.userId)
      && this.isVisible(memory, input.agentId, input.taskId) && matchesFactGroup(memory, input))
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt) || b.id.localeCompare(a.id));
    return { memories: structuredClone(rows.slice(0, input.limit)), truncated: rows.length > input.limit };
  }
  private belongsToUser(memory: ResolvedMemory, userId: string): boolean { return this.eventOwners.get(memory.sourceEventId) === userId; }
  private isVisible(memory: ResolvedMemory, agentId: string, taskId?: string): boolean {
    if (memory.scope === "agent") return memory.ownerAgentId === agentId;
    if (memory.scope === "task") return Boolean(taskId) && memory.taskId === taskId;
    return true;
  }

  private applyEvent(event: MemoryEvent): void {
    if (this.eventOwners.has(event.id) || this.idempotency.has(idempotencyKey(event.userId, event.idempotencyKey))) {
      throw new OpenContinuityError("STORAGE_ERROR", "Duplicate event identity in memory ledger", 500);
    }
    this.events.push(event);
    this.eventOwners.set(event.id, event.userId);
    if (event.type === "memory_forgotten") {
      const current = Array.from(this.resolved.values()).find((memory) => memory.id === event.memoryId && this.belongsToUser(memory, event.userId));
      if (!current) throw new OpenContinuityError("STORAGE_ERROR", "Forgotten memory has no current state in ledger", 500);
      this.resolved.delete(storedMemoryIdentity(event.userId, current));
      this.idempotency.set(idempotencyKey(event.userId, event.idempotencyKey), { event, duplicate: false, current });
      return;
    }
    const mapKey = memoryIdentity(event);
    const previous = this.resolved.get(mapKey);
    const current: ResolvedMemory = {
      id: event.memoryId, key: event.key, value: event.value, kind: event.kind, scope: event.scope, taskId: event.taskId, ownerAgentId: event.scope === "agent" ? event.agentId : undefined,
      sensitivity: event.sensitivity, userConfirmed: event.userConfirmed, sourceEventId: event.id, sourceAgentId: event.agentId,
      updatedAt: event.createdAt, version: event.memoryVersion ?? (previous?.version || 0) + 1, supersedes: event.supersedes, confidence: event.confidence, fact: event.fact,
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
export class JsonFileStore implements MemoryStore, MemoryRepository, CandidateSearchStore {
  private current: InMemoryStore;
  private readonly lockWaitMs = 5000;

  constructor(private readonly filePath = homedir() + "/.open-continuity/memories.json") {
    this.current = this.load();
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

  list(input: StructuredMemoryInput): RecallResult {
    assertStructuredInput(input);
    this.refresh();
    return this.current.list(input);
  }

  history(input: ParsedHistoryInput): HistoryResult {
    this.refresh();
    return this.current.history(input);
  }

  searchCandidates(input: CandidateSearchRequest): CandidateSearchResult {
    // Compatibility delegation only; no new JSON index or retrieval architecture.
    parseCandidateSearch(input);
    this.refresh();
    const result = this.current.searchCandidates(input);
    return { ...result, implementation: result.implementation === "inmemory_compatibility" ? "json_compatibility" : result.implementation };
  }
  readFactGroup(input: FactGroupRequest) {
    parseFactGroupRequest(input);
    this.refresh();
    return this.current.readFactGroup(input);
  }

  private refresh(): void {
    this.current = this.load();
  }

  private load(): InMemoryStore {
    try { return new InMemoryStore(this.readEvents()); }
    catch { throw new OpenContinuityError("STORAGE_ERROR", "Unable to read a valid memory ledger", 500); }
  }

  private readEvents(): MemoryEvent[] {
    if (!existsSync(this.filePath)) return [];
    try {
      return decodeEventLedger(JSON.parse(readFileSync(this.filePath, "utf8")));
    } catch (error) {
      if (error instanceof OpenContinuityError) throw error;
      throw new OpenContinuityError("STORAGE_ERROR", "Unable to read the memory store", 500);
    }
  }

  private persist(): void {
    mkdirSync(dirname(this.filePath), { recursive: true });
    const temporaryPath = this.filePath + "." + process.pid + "." + randomUUID() + ".tmp";
    try {
      const ledger = encodeEventLedger(this.current.allEvents());
      writeFileSync(temporaryPath, JSON.stringify(ledger, null, 2) + "\n", { encoding: "utf8", mode: 0o600, flag: "wx" });
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
        if ((error as NodeJS.ErrnoException).code !== "EEXIST" || Date.now() - startedAt >= this.lockWaitMs) {
          throw new OpenContinuityError("STORAGE_ERROR", "Unable to acquire the memory ledger lock", 500);
        }
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
      }
    }
    try {
      this.refresh();
      const result = operation();
      this.persist();
      return result;
    } catch (error) {
      if (error instanceof OpenContinuityError) throw error;
      throw new OpenContinuityError("STORAGE_ERROR", "Unable to persist the memory ledger", 500);
    } finally {
      closeSync(lockFd);
      unlinkSync(lockPath);
    }
  }
}
