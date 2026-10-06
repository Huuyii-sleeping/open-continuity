import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { dirname } from "node:path";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import { isDeepStrictEqual } from "node:util";
import { decodeCursor, encodeCursor } from "../core/cursor.js";
import { evolutionReceipt, evolutionReceiptFromEvent, resolveEvolution, sameEvolutionRequest } from "../core/evolution.js";
import type { MemoryReceiptLike, MemoryStore } from "../core/memory-store.js";
import { OpenContinuityError } from "../shared/errors.js";
import type { HistoryResult, MemoryEvent, MemoryKind, ParsedHistoryInput, ParsedRecallInput, ParsedRememberInput, RecallResult, ResolvedMemory } from "../shared/types.js";
import { configureSqlite, migrateSqlite } from "./schema.js";

type SqliteRow = Record<string, unknown>;

export interface SqliteMemoryStoreOptions {
  autoMigrate?: boolean;
}

function parseJson(value: unknown): unknown {
  return JSON.parse(String(value));
}

function scopeIdentity(input: { scope: string; taskId?: string; agentId?: string; ownerAgentId?: string }): string {
  if (input.scope === "task") return input.taskId!;
  if (input.scope === "agent") return input.ownerAgentId || input.agentId!;
  return "-";
}

function rowToMemory(row: SqliteRow): ResolvedMemory {
  const memory: ResolvedMemory = {
    id: String(row.id), key: String(row.memory_key), value: parseJson(row.value), kind: row.kind as ResolvedMemory["kind"],
    scope: row.scope as ResolvedMemory["scope"], taskId: row.task_id == null ? undefined : String(row.task_id),
    ownerAgentId: row.owner_agent_id == null ? undefined : String(row.owner_agent_id),
    sensitivity: row.sensitivity as ResolvedMemory["sensitivity"], userConfirmed: Number(row.user_confirmed) === 1,
    sourceEventId: String(row.source_event_id), sourceAgentId: String(row.source_agent_id),
    updatedAt: String(row.updated_at), version: Number(row.version),
  };
  if (row.supersedes_event_id != null && row.supersedes_version != null) memory.supersedes = { eventId: String(row.supersedes_event_id), version: Number(row.supersedes_version) };
  if (row.confidence != null && row.confidence_basis != null) memory.confidence = { score: Number(row.confidence), basis: row.confidence_basis as NonNullable<ResolvedMemory["confidence"]>["basis"] };
  return memory;
}

function rowToEvent(row: SqliteRow): MemoryEvent {
  const event: MemoryEvent = {
    id: String(row.id), userId: String(row.user_id), agentId: String(row.agent_id),
    type: row.event_type as MemoryEvent["type"], memoryId: String(row.memory_id), key: String(row.memory_key),
    kind: row.kind as MemoryEvent["kind"], scope: row.scope as MemoryEvent["scope"],
    taskId: row.task_id == null ? undefined : String(row.task_id), sensitivity: row.sensitivity as MemoryEvent["sensitivity"],
    userConfirmed: Number(row.user_confirmed) === 1, idempotencyKey: String(row.idempotency_key),
    createdAt: String(row.created_at), metadata: parseJson(row.metadata) as Record<string, unknown>,
    memoryVersion: Number(row.memory_version),
  };
  if (event.type === "memory_remembered") event.value = parseJson(row.value);
  if (event.type === "memory_remembered") {
    if (row.input_value != null) event.inputValue = parseJson(row.input_value);
    if (row.evolution_action != null) event.evolutionAction = row.evolution_action as NonNullable<MemoryEvent["evolutionAction"]>;
    if (row.write_mode != null) event.writeMode = row.write_mode as NonNullable<MemoryEvent["writeMode"]>;
    if (row.expected_version != null) event.expectedVersion = Number(row.expected_version);
    if (row.supersedes_event_id != null && row.supersedes_version != null) event.supersedes = { eventId: String(row.supersedes_event_id), version: Number(row.supersedes_version) };
    if (row.confidence != null && row.confidence_basis != null) event.confidence = { score: Number(row.confidence), basis: row.confidence_basis as NonNullable<MemoryEvent["confidence"]>["basis"] };
  }
  return event;
}

function eventSnapshot(row: SqliteRow): ResolvedMemory {
  const memory: ResolvedMemory = {
    id: String(row.memory_id), key: String(row.memory_key), value: parseJson(row.value),
    kind: row.kind as ResolvedMemory["kind"], scope: row.scope as ResolvedMemory["scope"],
    taskId: row.task_id == null ? undefined : String(row.task_id),
    ownerAgentId: row.scope === "agent" ? String(row.agent_id) : undefined,
    sensitivity: row.sensitivity as ResolvedMemory["sensitivity"], userConfirmed: Number(row.user_confirmed) === 1,
    sourceEventId: String(row.id), sourceAgentId: String(row.agent_id), updatedAt: String(row.created_at),
    version: Number(row.memory_version),
  };
  if (row.supersedes_event_id != null && row.supersedes_version != null) memory.supersedes = { eventId: String(row.supersedes_event_id), version: Number(row.supersedes_version) };
  if (row.confidence != null && row.confidence_basis != null) memory.confidence = { score: Number(row.confidence), basis: row.confidence_basis as NonNullable<ResolvedMemory["confidence"]>["basis"] };
  return memory;
}

function sameRequest(row: SqliteRow, input: ParsedRememberInput): boolean {
  return row.user_id === input.userId && row.agent_id === input.agentId && row.memory_key === input.key && row.kind === input.kind
    && row.scope === input.scope && (row.task_id ?? undefined) === input.taskId && row.sensitivity === input.sensitivity
    && Number(row.user_confirmed) === Number(input.userConfirmed) && sameEvolutionRequest({
      inputValue: row.input_value == null ? undefined : parseJson(row.input_value), value: parseJson(row.value),
      writeMode: row.write_mode == null ? undefined : String(row.write_mode),
      expectedVersion: row.expected_version == null ? undefined : Number(row.expected_version),
      confidence: row.confidence == null || row.confidence_basis == null ? undefined : { score: Number(row.confidence), basis: row.confidence_basis as NonNullable<ResolvedMemory["confidence"]>["basis"] },
    }, input)
    && isDeepStrictEqual(parseJson(row.metadata), input.metadata);
}

function ftsPhrase(query: string): string {
  return `"${query.replaceAll('\"', '\"\"')}"`;
}

export class SqliteMemoryStore implements MemoryStore {
  private readonly database: DatabaseSync;
  private closed = false;

  constructor(readonly databasePath = homedir() + "/.open-continuity/memories.db", options: SqliteMemoryStoreOptions = {}) {
    if (databasePath !== ":memory:") mkdirSync(dirname(databasePath), { recursive: true });
    const database = new DatabaseSync(databasePath);
    try {
      this.database = database;
      configureSqlite(this.database);
      if (options.autoMigrate !== false) migrateSqlite(this.database);
      else this.database.prepare("SELECT 1 FROM open_continuity_schema_migrations LIMIT 1").get();
    } catch (error) {
      if (database.isOpen) database.close();
      throw this.storageError(error);
    }
  }

  appendRemember(input: ParsedRememberInput): MemoryReceiptLike {
    return this.writeTransaction(() => {
      const duplicate = this.get("SELECT * FROM memory_events WHERE user_id = ? AND idempotency_key = ?", [input.userId, input.idempotencyKey]);
      if (duplicate) {
        if (!sameRequest(duplicate, input)) throw new OpenContinuityError("IDEMPOTENCY_CONFLICT", "Idempotency key was already used for a different request", 409, { idempotencyKey: input.idempotencyKey });
        const event = rowToEvent(duplicate);
        const current = eventSnapshot(duplicate);
        return { event, duplicate: true, current, evolution: evolutionReceiptFromEvent(event, current) };
      }

      const eventId = randomUUID();
      const candidateMemoryId = randomUUID();
      const timestamp = new Date().toISOString();
      const previousRow = this.get(
        "SELECT * FROM memories_current WHERE user_id = ? AND scope = ? AND scope_identity = ? AND memory_key = ?",
        [input.userId, input.scope, scopeIdentity(input), input.key],
      );
      const resolution = resolveEvolution(previousRow ? rowToMemory(previousRow) : undefined, input);
      const current = rowToMemory(this.getRequired(
        `INSERT INTO memories_current (id, user_id, memory_key, value, kind, scope, task_id, owner_agent_id, sensitivity, user_confirmed, source_event_id, source_agent_id, updated_at, version, scope_identity, supersedes_event_id, supersedes_version, confidence, confidence_basis)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (user_id, scope, scope_identity, memory_key) DO UPDATE SET
           value = excluded.value, kind = excluded.kind, task_id = excluded.task_id, owner_agent_id = excluded.owner_agent_id,
           sensitivity = excluded.sensitivity, user_confirmed = excluded.user_confirmed, source_event_id = excluded.source_event_id,
           source_agent_id = excluded.source_agent_id, updated_at = excluded.updated_at, version = excluded.version,
           supersedes_event_id = excluded.supersedes_event_id, supersedes_version = excluded.supersedes_version,
           confidence = excluded.confidence, confidence_basis = excluded.confidence_basis
         RETURNING *`,
        [candidateMemoryId, input.userId, input.key, JSON.stringify(resolution.value), input.kind, input.scope, input.taskId ?? null,
          input.scope === "agent" ? input.agentId : null, input.sensitivity, Number(input.userConfirmed), eventId, input.agentId,
          timestamp, resolution.version, scopeIdentity(input), resolution.supersedes?.eventId ?? null, resolution.supersedes?.version ?? null,
          resolution.confidence?.score ?? null, resolution.confidence?.basis ?? null],
      ));
      const event = rowToEvent(this.getRequired(
        `INSERT INTO memory_events (id, user_id, agent_id, event_type, memory_id, memory_key, value, kind, scope, task_id, sensitivity, user_confirmed, idempotency_key, created_at, metadata, memory_version, input_value, evolution_action, write_mode, expected_version, supersedes_event_id, supersedes_version, confidence, confidence_basis)
         VALUES (?, ?, ?, 'memory_remembered', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING *`,
        [eventId, input.userId, input.agentId, current.id, input.key, JSON.stringify(resolution.value), input.kind, input.scope,
          input.taskId ?? null, input.sensitivity, Number(input.userConfirmed), input.idempotencyKey, timestamp,
          JSON.stringify(input.metadata), current.version, JSON.stringify(input.value), resolution.action, input.writeMode, input.expectedVersion ?? null,
          resolution.supersedes?.eventId ?? null, resolution.supersedes?.version ?? null, resolution.confidence?.score ?? null, resolution.confidence?.basis ?? null],
      ));
      return { event, duplicate: false, current, evolution: evolutionReceipt(input, resolution) };
    });
  }

  appendForget(userId: string, agentId: string, memoryId: string, taskId?: string, includePrivate = false): MemoryReceiptLike {
    return this.writeTransaction(() => {
      const row = this.get(
        `SELECT * FROM memories_current WHERE user_id = ? AND id = ?
         AND (scope = 'user' OR (scope = 'agent' AND owner_agent_id = ?) OR (scope = 'task' AND ? IS NOT NULL AND task_id = ?))
         AND (? = 1 OR sensitivity <> 'private')`,
        [userId, memoryId, agentId, taskId ?? null, taskId ?? null, Number(includePrivate)],
      );
      if (!row) throw new OpenContinuityError("MEMORY_NOT_FOUND", "Memory not found", 404, { memoryId });
      const current = rowToMemory(row);
      const eventId = randomUUID();
      const timestamp = new Date().toISOString();
      const event = rowToEvent(this.getRequired(
        `INSERT INTO memory_events (id, user_id, agent_id, event_type, memory_id, memory_key, value, kind, scope, task_id, sensitivity, user_confirmed, idempotency_key, created_at, metadata, memory_version)
         VALUES (?, ?, ?, 'memory_forgotten', ?, ?, NULL, ?, ?, ?, ?, 1, ?, ?, '{}', ?) RETURNING *`,
        [eventId, userId, agentId, memoryId, current.key, current.kind, current.scope, current.taskId ?? null,
          current.sensitivity, `forget:${memoryId}:${randomUUID()}`, timestamp, current.version],
      ));
      this.run("DELETE FROM memories_current WHERE user_id = ? AND id = ?", [userId, memoryId]);
      return { event, duplicate: false, current };
    });
  }

  recall(input: ParsedRecallInput): RecallResult {
    this.assertOpen();
    const cursor = decodeCursor(input.cursor, "memory");
    const values: SQLInputValue[] = [input.userId, input.agentId, input.taskId ?? null, input.taskId ?? null, Number(input.includePrivate)];
    const clauses = [
      "user_id = ?",
      "(scope = 'user' OR (scope = 'agent' AND owner_agent_id = ?) OR (scope = 'task' AND ? IS NOT NULL AND task_id = ?))",
      "(? = 1 OR sensitivity <> 'private')",
    ];
    const add = (clause: string, value: SQLInputValue) => { clauses.push(clause); values.push(value); };
    if (input.scope) add("scope = ?", input.scope);
    if (input.key) add("memory_key = ?", input.key);
    if (input.kind) add("kind = ?", input.kind);
    if (input.query) {
      if ([...input.query].length >= 3) add("id IN (SELECT memory_id FROM memories_fts WHERE memories_fts MATCH ?)", ftsPhrase(input.query));
      else { clauses.push("(instr(lower(memory_key), lower(?)) > 0 OR instr(lower(value), lower(?)) > 0)"); values.push(input.query, input.query); }
    }
    if (cursor) { clauses.push("(updated_at < ? OR (updated_at = ? AND id < ?))"); values.push(cursor.timestamp, cursor.timestamp, cursor.id); }
    values.push(input.limit + 1);
    const rows = this.all(`SELECT * FROM memories_current WHERE ${clauses.join(" AND ")} ORDER BY updated_at DESC, id DESC LIMIT ?`, values).map(rowToMemory);
    const hasMore = rows.length > input.limit;
    const memories = hasMore ? rows.slice(0, input.limit) : rows;
    const last = memories.at(-1);
    return { memories, nextCursor: hasMore && last ? encodeCursor("memory", last.updatedAt, last.id) : null };
  }

  history(input: ParsedHistoryInput): HistoryResult {
    this.assertOpen();
    const cursor = decodeCursor(input.cursor, "event");
    const values: SQLInputValue[] = [input.userId, input.agentId, input.taskId ?? null, input.taskId ?? null, Number(input.includePrivate)];
    const clauses = [
      "user_id = ?",
      "(scope = 'user' OR (scope = 'agent' AND agent_id = ?) OR (scope = 'task' AND ? IS NOT NULL AND task_id = ?))",
      "(? = 1 OR sensitivity <> 'private')",
    ];
    if (input.memoryId) { clauses.push("memory_id = ?"); values.push(input.memoryId); }
    if (cursor) { clauses.push("(created_at < ? OR (created_at = ? AND id < ?))"); values.push(cursor.timestamp, cursor.timestamp, cursor.id); }
    values.push(input.limit + 1);
    const rows = this.all(`SELECT * FROM memory_events WHERE ${clauses.join(" AND ")} ORDER BY created_at DESC, id DESC LIMIT ?`, values).map(rowToEvent);
    const hasMore = rows.length > input.limit;
    const events = hasMore ? rows.slice(0, input.limit) : rows;
    const last = events.at(-1);
    return { events, nextCursor: hasMore && last ? encodeCursor("event", last.createdAt, last.id) : null };
  }

  importEvents(events: MemoryEvent[]): void {
    this.writeTransaction(() => {
      const count = this.getRequired("SELECT COUNT(*) AS count FROM memory_events", []);
      if (Number(count.count) !== 0) throw new OpenContinuityError("STORAGE_ERROR", "SQLite import target must be empty", 409);
      for (const event of events) this.importEvent(event);
    });
  }

  exportEvents(): MemoryEvent[] {
    this.assertOpen();
    return this.all("SELECT * FROM memory_events ORDER BY rowid ASC", []).map(rowToEvent);
  }

  inspectUserMemories(input: { userId: string; memoryId?: string; query?: string; kind?: MemoryKind; includePrivate?: boolean; limit?: number }): ResolvedMemory[] {
    this.assertOpen();
    const clauses = ["user_id = ?", "(? = 1 OR sensitivity <> 'private')"];
    const values: SQLInputValue[] = [input.userId, Number(input.includePrivate ?? true)];
    if (input.memoryId) { clauses.push("id = ?"); values.push(input.memoryId); }
    if (input.kind) { clauses.push("kind = ?"); values.push(input.kind); }
    if (input.query) { clauses.push("(instr(lower(memory_key), lower(?)) > 0 OR instr(lower(value), lower(?)) > 0)"); values.push(input.query, input.query); }
    values.push(input.limit ?? 20);
    return this.all(`SELECT * FROM memories_current WHERE ${clauses.join(" AND ")} ORDER BY updated_at DESC, id DESC LIMIT ?`, values).map(rowToMemory);
  }

  inspectUserHistory(input: { userId: string; memoryId?: string; includePrivate?: boolean; limit?: number }): MemoryEvent[] {
    this.assertOpen();
    const clauses = ["user_id = ?", "(? = 1 OR sensitivity <> 'private')"];
    const values: SQLInputValue[] = [input.userId, Number(input.includePrivate ?? true)];
    if (input.memoryId) { clauses.push("memory_id = ?"); values.push(input.memoryId); }
    values.push(input.limit ?? 100);
    return this.all(`SELECT * FROM memory_events WHERE ${clauses.join(" AND ")} ORDER BY created_at DESC, id DESC LIMIT ?`, values).map(rowToEvent);
  }

  forgetOwnedMemory(userId: string, memoryId: string, actorAgentId = "open-continuity-cli"): MemoryReceiptLike {
    this.assertOpen();
    const row = this.get("SELECT * FROM memories_current WHERE user_id = ? AND id = ?", [userId, memoryId]);
    if (!row) throw new OpenContinuityError("MEMORY_NOT_FOUND", "Memory not found", 404, { memoryId });
    const memory = rowToMemory(row);
    return this.appendForget(userId, memory.scope === "agent" ? memory.ownerAgentId! : actorAgentId, memoryId, memory.taskId, true);
  }

  close(): void {
    if (this.closed) return;
    this.database.close();
    this.closed = true;
  }

  private importEvent(event: MemoryEvent): void {
    if (event.type === "memory_forgotten") {
      const currentRow = this.get("SELECT * FROM memories_current WHERE user_id = ? AND id = ?", [event.userId, event.memoryId]);
      if (!currentRow) throw new OpenContinuityError("VALIDATION_ERROR", "Forgotten memory has no current imported state", 400, { eventId: event.id, memoryId: event.memoryId });
      const current = rowToMemory(currentRow);
      this.run(
        `INSERT INTO memory_events (id, user_id, agent_id, event_type, memory_id, memory_key, value, kind, scope, task_id, sensitivity, user_confirmed, idempotency_key, created_at, metadata, memory_version)
         VALUES (?, ?, ?, 'memory_forgotten', ?, ?, NULL, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [event.id, event.userId, event.agentId, event.memoryId, event.key, event.kind, event.scope, event.taskId ?? null,
          event.sensitivity, Number(event.userConfirmed), event.idempotencyKey, event.createdAt, JSON.stringify(event.metadata), current.version],
      );
      this.run("DELETE FROM memories_current WHERE user_id = ? AND id = ?", [event.userId, event.memoryId]);
      return;
    }

    const previousRow = this.get("SELECT * FROM memories_current WHERE user_id = ? AND scope = ? AND scope_identity = ? AND memory_key = ?",
      [event.userId, event.scope, scopeIdentity({ scope: event.scope, taskId: event.taskId, agentId: event.agentId }), event.key]);
    const inferredVersion = event.memoryVersion ?? (previousRow ? Number(previousRow.version) + 1 : 1);
    const current = rowToMemory(this.getRequired(
      `INSERT INTO memories_current (id, user_id, memory_key, value, kind, scope, task_id, owner_agent_id, sensitivity, user_confirmed, source_event_id, source_agent_id, updated_at, version, scope_identity, supersedes_event_id, supersedes_version, confidence, confidence_basis)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (user_id, scope, scope_identity, memory_key) DO UPDATE SET
         id = excluded.id, value = excluded.value, kind = excluded.kind, task_id = excluded.task_id, owner_agent_id = excluded.owner_agent_id,
         sensitivity = excluded.sensitivity, user_confirmed = excluded.user_confirmed, source_event_id = excluded.source_event_id,
         source_agent_id = excluded.source_agent_id, updated_at = excluded.updated_at, version = excluded.version,
         supersedes_event_id = excluded.supersedes_event_id, supersedes_version = excluded.supersedes_version, confidence = excluded.confidence, confidence_basis = excluded.confidence_basis
       RETURNING *`,
      [event.memoryId, event.userId, event.key, JSON.stringify(event.value), event.kind, event.scope, event.taskId ?? null,
        event.scope === "agent" ? event.agentId : null, event.sensitivity, Number(event.userConfirmed), event.id, event.agentId,
        event.createdAt, inferredVersion, scopeIdentity({ scope: event.scope, taskId: event.taskId, agentId: event.agentId }),
        event.supersedes?.eventId ?? null, event.supersedes?.version ?? null, event.confidence?.score ?? null, event.confidence?.basis ?? null],
    ));
    this.run(
      `INSERT INTO memory_events (id, user_id, agent_id, event_type, memory_id, memory_key, value, kind, scope, task_id, sensitivity, user_confirmed, idempotency_key, created_at, metadata, memory_version, input_value, evolution_action, write_mode, expected_version, supersedes_event_id, supersedes_version, confidence, confidence_basis)
       VALUES (?, ?, ?, 'memory_remembered', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [event.id, event.userId, event.agentId, current.id, event.key, JSON.stringify(event.value), event.kind, event.scope,
        event.taskId ?? null, event.sensitivity, Number(event.userConfirmed), event.idempotencyKey, event.createdAt,
        JSON.stringify(event.metadata), current.version, event.inputValue === undefined ? null : JSON.stringify(event.inputValue), event.evolutionAction ?? null, event.writeMode ?? null,
        event.expectedVersion ?? null, event.supersedes?.eventId ?? null, event.supersedes?.version ?? null, event.confidence?.score ?? null, event.confidence?.basis ?? null],
    );
  }

  private writeTransaction<T>(operation: () => T): T {
    this.assertOpen();
    try {
      this.database.exec("BEGIN IMMEDIATE");
      const result = operation();
      this.database.exec("COMMIT");
      return result;
    } catch (error) {
      if (this.database.isTransaction) this.database.exec("ROLLBACK");
      if (error instanceof OpenContinuityError) throw error;
      throw this.storageError(error);
    }
  }

  private run(sql: string, values: SQLInputValue[]): void { this.database.prepare(sql).run(...values); }
  private get(sql: string, values: SQLInputValue[]): SqliteRow | undefined { return this.database.prepare(sql).get(...values) as SqliteRow | undefined; }
  private getRequired(sql: string, values: SQLInputValue[]): SqliteRow {
    const row = this.get(sql, values);
    if (!row) throw new Error("SQLite statement returned no row");
    return row;
  }
  private all(sql: string, values: SQLInputValue[]): SqliteRow[] { return this.database.prepare(sql).all(...values) as SqliteRow[]; }
  private assertOpen(): void { if (this.closed) throw new OpenContinuityError("STORAGE_ERROR", "SQLite store is closed", 500); }
  private storageError(error: unknown): OpenContinuityError {
    return new OpenContinuityError("STORAGE_ERROR", "SQLite operation failed", 500, process.env.NODE_ENV === "development" && error instanceof Error ? error.message : undefined);
  }
}
