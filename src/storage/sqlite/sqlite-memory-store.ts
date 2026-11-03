import type { SqliteRecordContext, SqliteWriteContext } from "./contracts.js";

import { chmodSync, existsSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { dirname } from "node:path";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import { type FactGroupRequest } from "../../core/facts/contracts.js";
import type { MemoryReceiptLike, MemoryStore } from "../../core/memory/contracts.js";
import { assertStructuredInput, type MemoryRepository, type StructuredMemoryInput } from "../../core/memory/storage-contract.js";
import type { CandidateSearchRequest, CandidateSearchResult, CandidateSearchStore } from "../../core/retrieval/contracts.js";
import { LEXICAL_FALLBACK_VERSION } from "../../core/retrieval/full-text/lexical-fallback.js";
import { dispatchCandidateSearch } from "../../core/retrieval/readers.js";
import { OpenContinuityError } from "../../shared/errors.js";
import type { HistoryResult, MemoryEvent, MemoryKind, ParsedHistoryInput, ParsedRecallInput, ParsedRememberInput, RecallResult, ResolvedMemory } from "../../shared/types.js";
import { type MemoryFact } from "../../shared/types.js";
import { createSqliteCandidateReaders } from "./readers/index.js";
import { factGroupSqlite } from "./records/facts.js";
import { historySqlite } from "./records/history.js";
import { inspectSqliteHistory } from "./records/inspect-history.js";
import { inspectSqliteMemories } from "./records/inspect-memories.js";
import { listSqlite } from "./records/list.js";
import { rowToMemory, type SqliteRow } from "./row-mapping.js";
import { assertSqliteSchemaVersion, configureSqlite, migrateSqlite } from "./schema.js";
import { applySqliteEvent } from "./transfer/apply-event.js";
import { exportSqliteEvents } from "./transfer/export-events.js";
import { importSqliteEvents } from "./transfer/import-events.js";
import { writeSqliteFact } from "./writes/fact-fields.js";
import { forgetSqlite } from "./writes/forget.js";
import { rememberSqlite } from "./writes/remember.js";
import { SqliteDenseIndex } from "./dense-index.js";
import type { EmbeddingModelSpec } from "../../core/retrieval/dense/index-contracts.js";
import { SQLITE_LEXICAL_INDEX_VERSION } from "./lexical-index.js";

export interface SqliteMemoryStoreOptions {
  autoMigrate?: boolean;
  /** Explicit lock-wait tuning only; not a SQL execution deadline. */
  busyTimeoutMs?: number;
}


export class SqliteMemoryStore implements MemoryStore, MemoryRepository, CandidateSearchStore {
  readonly handoffReviewVersion = "handoff-review-v1" as const;
  readonly lexicalFallbackVersion = LEXICAL_FALLBACK_VERSION;
  readonly lexicalIndexVersion?: typeof SQLITE_LEXICAL_INDEX_VERSION;
  readonly candidateReaders = createSqliteCandidateReaders({
    assertOpen: () => this.assertOpen(),
    lexicalIndexVersion: () => this.lexicalIndexVersion,
    all: (sql, values) => this.all(sql, values),
    storageError: error => this.storageError(error),
  });
  private readonly database: DatabaseSync;
  private closed = false;
  private readonly recordOperations: SqliteRecordContext = { assertOpen: () => this.assertOpen(), all: (sql, values) => this.all(sql, values), get: (sql, values) => this.get(sql, values), storageError: error => this.storageError(error) };
  private readonly writeOperations: SqliteWriteContext = { ...this.recordOperations, run: (sql, values) => this.run(sql, values), getRequired: (sql, values) => this.getRequired(sql, values), writeTransaction: operation => this.writeTransaction(operation), writeFact: (memoryId, eventId, fact) => this.writeFact(memoryId, eventId, fact), importEvent: event => this.importEvent(event) };

  constructor(readonly databasePath = homedir() + "/.open-continuity/memories.db", options: SqliteMemoryStoreOptions = {}) {
    if (options.busyTimeoutMs !== undefined && (!Number.isInteger(options.busyTimeoutMs) || options.busyTimeoutMs < 0 || options.busyTimeoutMs > 10000)) {
      throw new OpenContinuityError("VALIDATION_ERROR", "Invalid SQLite lock-wait budget", 400);
    }
    if (databasePath !== ":memory:") mkdirSync(dirname(databasePath), { recursive: true });
    const database = new DatabaseSync(databasePath);
    try {
      this.database = database;
      configureSqlite(this.database);
      if (options.autoMigrate !== false) migrateSqlite(this.database);
      else assertSqliteSchemaVersion(this.database);
      if (assertSqliteSchemaVersion(this.database).has(5)) this.lexicalIndexVersion = SQLITE_LEXICAL_INDEX_VERSION;
      if (options.busyTimeoutMs !== undefined) this.database.exec(`PRAGMA busy_timeout = ${options.busyTimeoutMs}`);
      this.secureDatabaseFiles();
    } catch (error) {
      if (database.isOpen) database.close();
      throw this.storageError(error);
    }
  }

  appendRemember(input: ParsedRememberInput): MemoryReceiptLike { return rememberSqlite(this.writeOperations, input); }

  /** Explicit experimental feature; installs only rebuildable Dense tables/triggers. */
  enableDenseIndex(model: EmbeddingModelSpec, options: { reset?: boolean } = {}): SqliteDenseIndex {
    this.assertOpen(); return new SqliteDenseIndex(this.database, model, options.reset);
  }

  appendForget(userId: string, agentId: string, memoryId: string, taskId?: string, includePrivate = false): MemoryReceiptLike { return forgetSqlite(this.writeOperations, userId, agentId, memoryId, taskId, includePrivate); }

  list(input: StructuredMemoryInput): RecallResult { assertStructuredInput(input); return this.read(input); }

  recall(input: ParsedRecallInput): RecallResult { return input.query === undefined ? this.list(input as StructuredMemoryInput) : this.read(input); }

  private read(input: ParsedRecallInput): RecallResult { return listSqlite(this.recordOperations, input); }

  searchCandidates(request: CandidateSearchRequest): CandidateSearchResult {
    this.assertOpen();
    return dispatchCandidateSearch(request, this.candidateReaders);
  }

  history(input: ParsedHistoryInput): HistoryResult { return historySqlite(this.recordOperations, input); }
  readFactGroup(request: FactGroupRequest) { return factGroupSqlite(this.recordOperations, request); }

  importEvents(events: MemoryEvent[]): void { return importSqliteEvents(this.writeOperations, events); }

  exportEvents(): MemoryEvent[] { return exportSqliteEvents(this.recordOperations); }

  inspectUserMemories(input: { userId: string; memoryId?: string; query?: string; kind?: MemoryKind; includePrivate?: boolean; limit?: number }): ResolvedMemory[] { return inspectSqliteMemories(this.recordOperations, input); }

  inspectUserHistory(input: { userId: string; memoryId?: string; includePrivate?: boolean; limit?: number }): MemoryEvent[] { return inspectSqliteHistory(this.recordOperations, input); }

  forgetOwnedMemory(userId: string, memoryId: string, actorAgentId = "open-continuity-cli"): MemoryReceiptLike {
    this.assertOpen();
    const row = this.get("SELECT * FROM memories_current WHERE user_id = ? AND id = ?", [userId, memoryId]);
    if (!row) throw new OpenContinuityError("MEMORY_NOT_FOUND", "Memory not found", 404, { memoryId });
    const memory = rowToMemory(row);
    return this.appendForget(userId, memory.scope === "agent" ? memory.ownerAgentId! : actorAgentId, memoryId, memory.taskId, true);
  }

  close(): void {
    if (this.closed) return;
    this.secureDatabaseFiles();
    this.database.close();
    this.closed = true;
  }

  private secureDatabaseFiles(): void {
    if (this.databasePath === ":memory:") return;
    for (const path of [this.databasePath, `${this.databasePath}-wal`, `${this.databasePath}-shm`]) {
      if (existsSync(path)) chmodSync(path, 0o600);
    }
  }

  private importEvent(event: MemoryEvent): void { return applySqliteEvent(this.writeOperations, event); }

  private writeFact(memoryId: string, eventId: string, fact?: MemoryFact): void { return writeSqliteFact(this.writeOperations, memoryId, eventId, fact); }

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
    if (error instanceof OpenContinuityError) return error;
    return new OpenContinuityError("STORAGE_ERROR", "SQLite operation failed", 500);
  }
}
