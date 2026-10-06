import { randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { Pool } from "pg";
import type { QueryResult, QueryResultRow } from "pg";
import { decodeCursor, encodeCursor } from "../core/cursor.js";
import { evolutionReceipt, evolutionReceiptFromEvent, resolveEvolution, sameEvolutionRequest } from "../core/evolution.js";
import type { MemoryReceiptLike, MemoryStore } from "../core/memory-store.js";
import { OpenContinuityError } from "../shared/errors.js";
import type { HistoryResult, MemoryEvent, ParsedHistoryInput, ParsedRecallInput, ParsedRememberInput, RecallResult, ResolvedMemory } from "../shared/types.js";
import { migratePostgres } from "./schema.js";

export interface DatabaseClient {
  query(text: string, values?: unknown[]): Promise<QueryResult>;
  release(): void;
}

export interface DatabasePool {
  connect(): Promise<DatabaseClient>;
  end?(): Promise<void>;
}

interface PostgresMemoryStoreOptions {
  autoMigrate?: boolean;
  ownsPool?: boolean;
}

function iso(value: unknown): string {
  return value instanceof Date ? value.toISOString() : new Date(String(value)).toISOString();
}

function scopeIdentity(input: { scope: string; taskId?: string; agentId?: string; ownerAgentId?: string }): string {
  if (input.scope === "task") return input.taskId!;
  if (input.scope === "agent") return input.ownerAgentId || input.agentId!;
  return "-";
}

function rowToMemory(row: QueryResultRow): ResolvedMemory {
  const memory: ResolvedMemory = {
    id: row.id, key: row.memory_key, value: row.value, kind: row.kind, scope: row.scope,
    taskId: row.task_id ?? undefined, ownerAgentId: row.owner_agent_id ?? undefined, sensitivity: row.sensitivity,
    userConfirmed: row.user_confirmed, sourceEventId: row.source_event_id, sourceAgentId: row.source_agent_id,
    updatedAt: iso(row.updated_at), version: row.version,
  };
  if (row.supersedes_event_id != null && row.supersedes_version != null) memory.supersedes = { eventId: row.supersedes_event_id, version: row.supersedes_version };
  if (row.confidence != null && row.confidence_basis != null) memory.confidence = { score: Number(row.confidence), basis: row.confidence_basis };
  return memory;
}

function rowToEvent(row: QueryResultRow): MemoryEvent {
  const event: MemoryEvent = {
    id: row.id, userId: row.user_id, agentId: row.agent_id, type: row.event_type, memoryId: row.memory_id,
    key: row.memory_key, kind: row.kind, scope: row.scope, taskId: row.task_id ?? undefined, sensitivity: row.sensitivity,
    userConfirmed: row.user_confirmed, idempotencyKey: row.idempotency_key, createdAt: iso(row.created_at), metadata: row.metadata ?? {}, memoryVersion: row.memory_version,
  };
  if (row.event_type === "memory_remembered") event.value = row.value;
  if (row.event_type === "memory_remembered") {
    if (row.input_value != null) event.inputValue = row.input_value;
    if (row.evolution_action != null) event.evolutionAction = row.evolution_action;
    if (row.write_mode != null) event.writeMode = row.write_mode;
    if (row.expected_version != null) event.expectedVersion = row.expected_version;
    if (row.supersedes_event_id != null && row.supersedes_version != null) event.supersedes = { eventId: row.supersedes_event_id, version: row.supersedes_version };
    if (row.confidence != null && row.confidence_basis != null) event.confidence = { score: Number(row.confidence), basis: row.confidence_basis };
  }
  return event;
}

function eventSnapshot(row: QueryResultRow): ResolvedMemory {
  const memory: ResolvedMemory = {
    id: row.memory_id, key: row.memory_key, value: row.value, kind: row.kind, scope: row.scope, taskId: row.task_id ?? undefined,
    ownerAgentId: row.scope === "agent" ? row.agent_id : undefined, sensitivity: row.sensitivity, userConfirmed: row.user_confirmed,
    sourceEventId: row.id, sourceAgentId: row.agent_id, updatedAt: iso(row.created_at), version: row.memory_version,
  };
  if (row.supersedes_event_id != null && row.supersedes_version != null) memory.supersedes = { eventId: row.supersedes_event_id, version: row.supersedes_version };
  if (row.confidence != null && row.confidence_basis != null) memory.confidence = { score: Number(row.confidence), basis: row.confidence_basis };
  return memory;
}

function sameRequest(row: QueryResultRow, input: ParsedRememberInput): boolean {
  return row.user_id === input.userId && row.agent_id === input.agentId && row.memory_key === input.key && row.kind === input.kind
    && row.scope === input.scope && (row.task_id ?? undefined) === input.taskId && row.sensitivity === input.sensitivity
    && row.user_confirmed === input.userConfirmed && sameEvolutionRequest({
      inputValue: row.input_value ?? undefined, value: row.value, writeMode: row.write_mode ?? undefined,
      expectedVersion: row.expected_version ?? undefined,
      confidence: row.confidence == null || row.confidence_basis == null ? undefined : { score: Number(row.confidence), basis: row.confidence_basis },
    }, input)
    && isDeepStrictEqual(row.metadata ?? {}, input.metadata);
}

export class PostgresMemoryStore implements MemoryStore {
  private ready?: Promise<void>;
  private readonly autoMigrate: boolean;
  private readonly ownsPool: boolean;

  constructor(private readonly pool: DatabasePool, options: PostgresMemoryStoreOptions = {}) {
    this.ownsPool = options.ownsPool ?? false;
    this.autoMigrate = options.autoMigrate !== false;
  }

  static fromConnectionString(connectionString: string, options: Omit<PostgresMemoryStoreOptions, "ownsPool"> = {}): PostgresMemoryStore {
    return new PostgresMemoryStore(new Pool({ connectionString }), { ...options, ownsPool: true });
  }

  async initialize(): Promise<void> {
    if (!this.ready) this.ready = this.initializeDatabase();
    await this.ready;
  }

  async appendRemember(input: ParsedRememberInput): Promise<MemoryReceiptLike> {
    await this.initialize();
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const existing = await client.query("SELECT * FROM memory_events WHERE user_id = $1 AND idempotency_key = $2", [input.userId, input.idempotencyKey]);
      if (existing.rows[0]) {
        if (!sameRequest(existing.rows[0], input)) throw new OpenContinuityError("IDEMPOTENCY_CONFLICT", "Idempotency key was already used for a different request", 409, { idempotencyKey: input.idempotencyKey });
        await client.query("COMMIT");
        const event = rowToEvent(existing.rows[0]);
        const current = eventSnapshot(existing.rows[0]);
        return { event, duplicate: true, current, evolution: evolutionReceiptFromEvent(event, current) };
      }

      const eventId = randomUUID();
      const candidateMemoryId = randomUUID();
      const timestamp = new Date().toISOString();
      const identity = scopeIdentity(input);
      const previousResult = await client.query(
        "SELECT * FROM memories_current WHERE user_id = $1 AND scope = $2 AND scope_identity = $3 AND memory_key = $4 FOR UPDATE",
        [input.userId, input.scope, identity, input.key],
      );
      const resolution = resolveEvolution(previousResult.rows[0] ? rowToMemory(previousResult.rows[0]) : undefined, input);
      const currentResult = input.expectedVersion !== undefined && previousResult.rows[0]
        ? await client.query(
          `UPDATE memories_current SET value = $1::jsonb, kind = $2, task_id = $3, owner_agent_id = $4, sensitivity = $5, user_confirmed = $6,
             source_event_id = $7, source_agent_id = $8, updated_at = $9, version = version + 1, supersedes_event_id = $10,
             supersedes_version = $11, confidence = $12, confidence_basis = $13
           WHERE user_id = $14 AND scope = $15 AND scope_identity = $16 AND memory_key = $17 AND version = $18 RETURNING *`,
          [JSON.stringify(resolution.value ?? null), input.kind, input.taskId ?? null, input.scope === "agent" ? input.agentId : null, input.sensitivity, input.userConfirmed, eventId, input.agentId, timestamp, resolution.supersedes?.eventId ?? null, resolution.supersedes?.version ?? null, resolution.confidence?.score ?? null, resolution.confidence?.basis ?? null, input.userId, input.scope, identity, input.key, input.expectedVersion],
        )
        : await client.query(
          `INSERT INTO memories_current (id, user_id, memory_key, value, kind, scope, task_id, owner_agent_id, sensitivity, user_confirmed, source_event_id, source_agent_id, updated_at, version, scope_identity, supersedes_event_id, supersedes_version, confidence, confidence_basis)
           VALUES ($1, $2, $3, $4::jsonb, $5, $6, $7, $8, $9, $10, $11, $12, $13, 1, $14, $15, $16, $17, $18)
           ON CONFLICT (user_id, scope, scope_identity, memory_key) DO UPDATE SET
             value = EXCLUDED.value, kind = EXCLUDED.kind, task_id = EXCLUDED.task_id, owner_agent_id = EXCLUDED.owner_agent_id,
             sensitivity = EXCLUDED.sensitivity, user_confirmed = EXCLUDED.user_confirmed, source_event_id = EXCLUDED.source_event_id,
             source_agent_id = EXCLUDED.source_agent_id, updated_at = EXCLUDED.updated_at, version = memories_current.version + 1,
             supersedes_event_id = EXCLUDED.supersedes_event_id, supersedes_version = EXCLUDED.supersedes_version,
             confidence = EXCLUDED.confidence, confidence_basis = EXCLUDED.confidence_basis
           WHERE ($19::integer IS NULL OR memories_current.version = $19)
           RETURNING *`,
          [candidateMemoryId, input.userId, input.key, JSON.stringify(resolution.value ?? null), input.kind, input.scope, input.taskId ?? null, input.scope === "agent" ? input.agentId : null, input.sensitivity, input.userConfirmed, eventId, input.agentId, timestamp, identity, resolution.supersedes?.eventId ?? null, resolution.supersedes?.version ?? null, resolution.confidence?.score ?? null, resolution.confidence?.basis ?? null, input.expectedVersion ?? null],
        );
      if (!currentResult.rows[0]) {
        const latest = await client.query(
          "SELECT id, version, source_event_id FROM memories_current WHERE user_id = $1 AND scope = $2 AND scope_identity = $3 AND memory_key = $4",
          [input.userId, input.scope, identity, input.key],
        );
        throw new OpenContinuityError("VERSION_CONFLICT", "Memory version does not match expectedVersion", 409, {
          expectedVersion: input.expectedVersion, currentVersion: latest.rows[0]?.version ?? 0, memoryId: latest.rows[0]?.id, currentSourceEventId: latest.rows[0]?.source_event_id,
        });
      }
      const current = rowToMemory(currentResult.rows[0]);
      const actualAction = current.version === 1 ? "created" : input.writeMode === "merge" ? "merged" : "replaced";
      const eventResult = await client.query(
        `INSERT INTO memory_events (id, user_id, agent_id, event_type, memory_id, memory_key, value, kind, scope, task_id, sensitivity, user_confirmed, idempotency_key, created_at, metadata, memory_version, input_value, evolution_action, write_mode, expected_version, supersedes_event_id, supersedes_version, confidence, confidence_basis)
         VALUES ($1, $2, $3, 'memory_remembered', $4, $5, $6::jsonb, $7, $8, $9, $10, $11, $12, $13, $14::jsonb, $15, $16::jsonb, $17, $18, $19, $20, $21, $22, $23) RETURNING *`,
        [eventId, input.userId, input.agentId, current.id, input.key, JSON.stringify(resolution.value ?? null), input.kind, input.scope, input.taskId ?? null, input.sensitivity, input.userConfirmed, input.idempotencyKey, timestamp, JSON.stringify(input.metadata), current.version, JSON.stringify(input.value ?? null), actualAction, input.writeMode, input.expectedVersion ?? null, current.supersedes?.eventId ?? null, current.supersedes?.version ?? null, resolution.confidence?.score ?? null, resolution.confidence?.basis ?? null],
      );
      await client.query("COMMIT");
      const event = rowToEvent(eventResult.rows[0]);
      return { event, duplicate: false, current, evolution: evolutionReceiptFromEvent(event, current) };
    } catch (error) {
      await client.query("ROLLBACK");
      if (error instanceof OpenContinuityError) throw error;
      if (this.isUniqueViolation(error)) return this.readDuplicate(input);
      throw this.storageError(error);
    } finally { client.release(); }
  }

  async appendForget(userId: string, agentId: string, memoryId: string, taskId?: string, includePrivate = false): Promise<MemoryReceiptLike> {
    await this.initialize();
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const values: unknown[] = [userId, memoryId, agentId, taskId ?? null, includePrivate];
      const result = await client.query(
        `SELECT * FROM memories_current WHERE user_id = $1 AND id = $2
         AND (scope = 'user' OR (scope = 'agent' AND owner_agent_id = $3) OR (scope = 'task' AND $4::text IS NOT NULL AND task_id = $4))
         AND ($5::boolean OR sensitivity <> 'private') FOR UPDATE`, values,
      );
      if (!result.rows[0]) throw new OpenContinuityError("MEMORY_NOT_FOUND", "Memory not found", 404, { memoryId });
      const current = rowToMemory(result.rows[0]);
      const eventId = randomUUID();
      const timestamp = new Date().toISOString();
      const eventResult = await client.query(
        `INSERT INTO memory_events (id, user_id, agent_id, event_type, memory_id, memory_key, value, kind, scope, task_id, sensitivity, user_confirmed, idempotency_key, created_at, metadata, memory_version)
         VALUES ($1, $2, $3, 'memory_forgotten', $4, $5, NULL, $6, $7, $8, $9, TRUE, $10, $11, '{}'::jsonb, $12) RETURNING *`,
        [eventId, userId, agentId, memoryId, current.key, current.kind, current.scope, current.taskId ?? null, current.sensitivity, "forget:" + memoryId + ":" + randomUUID(), timestamp, current.version],
      );
      await client.query("DELETE FROM memories_current WHERE user_id = $1 AND id = $2", [userId, memoryId]);
      await client.query("COMMIT");
      return { event: rowToEvent(eventResult.rows[0]), duplicate: false, current };
    } catch (error) {
      await client.query("ROLLBACK");
      if (error instanceof OpenContinuityError) throw error;
      throw this.storageError(error);
    } finally { client.release(); }
  }

  async recall(input: ParsedRecallInput): Promise<RecallResult> {
    await this.initialize();
    const cursor = decodeCursor(input.cursor, "memory");
    const values: unknown[] = [input.userId, input.agentId, input.taskId ?? null, input.includePrivate];
    const clauses = [
      "user_id = $1",
      "(scope = 'user' OR (scope = 'agent' AND owner_agent_id = $2) OR (scope = 'task' AND $3::text IS NOT NULL AND task_id = $3))",
      "($4::boolean OR sensitivity <> 'private')",
    ];
    const add = (clause: string, value: unknown) => { values.push(value); clauses.push(clause.replace("?", "$" + values.length)); };
    if (input.scope) add("scope = ?", input.scope);
    if (input.key) add("memory_key = ?", input.key);
    if (input.kind) add("kind = ?", input.kind);
    if (input.query) { values.push("%" + input.query + "%"); clauses.push("(memory_key ILIKE $" + values.length + " OR value::text ILIKE $" + values.length + ")"); }
    if (cursor) { values.push(cursor.timestamp, cursor.id); clauses.push("(updated_at < $" + (values.length - 1) + "::timestamptz OR (updated_at = $" + (values.length - 1) + "::timestamptz AND id < $" + values.length + "::uuid))"); }
    values.push(input.limit + 1);
    const result = await this.query(`SELECT * FROM memories_current WHERE ${clauses.join(" AND ")} ORDER BY updated_at DESC, id DESC LIMIT $${values.length}`, values);
    const rows = result.rows.map(rowToMemory);
    const hasMore = rows.length > input.limit;
    const memories = hasMore ? rows.slice(0, input.limit) : rows;
    const last = memories.at(-1);
    return { memories, nextCursor: hasMore && last ? encodeCursor("memory", last.updatedAt, last.id) : null };
  }

  async history(input: ParsedHistoryInput): Promise<HistoryResult> {
    await this.initialize();
    const cursor = decodeCursor(input.cursor, "event");
    const values: unknown[] = [input.userId, input.agentId, input.taskId ?? null, input.includePrivate];
    const clauses = [
      "user_id = $1",
      "(scope = 'user' OR (scope = 'agent' AND agent_id = $2) OR (scope = 'task' AND $3::text IS NOT NULL AND task_id = $3))",
      "($4::boolean OR sensitivity <> 'private')",
    ];
    if (input.memoryId) { values.push(input.memoryId); clauses.push("memory_id = $" + values.length + "::uuid"); }
    if (cursor) { values.push(cursor.timestamp, cursor.id); clauses.push("(created_at < $" + (values.length - 1) + "::timestamptz OR (created_at = $" + (values.length - 1) + "::timestamptz AND id < $" + values.length + "::uuid))"); }
    values.push(input.limit + 1);
    const result = await this.query(`SELECT * FROM memory_events WHERE ${clauses.join(" AND ")} ORDER BY created_at DESC, id DESC LIMIT $${values.length}`, values);
    const rows = result.rows.map(rowToEvent);
    const hasMore = rows.length > input.limit;
    const events = hasMore ? rows.slice(0, input.limit) : rows;
    const last = events.at(-1);
    return { events, nextCursor: hasMore && last ? encodeCursor("event", last.createdAt, last.id) : null };
  }

  async close(): Promise<void> { if (this.ownsPool) await this.pool.end?.(); }

  private async migrate(): Promise<void> {
    const client = await this.pool.connect();
    try { await migratePostgres(client); } finally { client.release(); }
  }

  private async initializeDatabase(): Promise<void> {
    try {
      if (this.autoMigrate) await this.migrate();
      else await this.query("SELECT 1", []);
    } catch (error) {
      if (error instanceof OpenContinuityError) throw error;
      throw this.storageError(error);
    }
  }

  private async query(text: string, values: unknown[]): Promise<QueryResult> {
    const client = await this.pool.connect();
    try { return await client.query(text, values); } catch (error) { throw this.storageError(error); } finally { client.release(); }
  }

  private async readDuplicate(input: ParsedRememberInput): Promise<MemoryReceiptLike> {
    const result = await this.query("SELECT * FROM memory_events WHERE user_id = $1 AND idempotency_key = $2", [input.userId, input.idempotencyKey]);
    const row = result.rows[0];
    if (!row || !sameRequest(row, input)) throw new OpenContinuityError("IDEMPOTENCY_CONFLICT", "Idempotency key was already used for a different request", 409, { idempotencyKey: input.idempotencyKey });
    const event = rowToEvent(row);
    const current = eventSnapshot(row);
    return { event, duplicate: true, current, evolution: evolutionReceiptFromEvent(event, current) };
  }

  private isUniqueViolation(error: unknown): boolean { return Boolean(error && typeof error === "object" && "code" in error && error.code === "23505"); }
  private storageError(error: unknown): OpenContinuityError {
    return new OpenContinuityError("STORAGE_ERROR", "PostgreSQL operation failed", 500, process.env.NODE_ENV === "development" && error instanceof Error ? error.message : undefined);
  }
}
