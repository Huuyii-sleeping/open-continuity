import type { QueryResult } from "pg";
import { Pool } from "pg";
import { type FactGroupRequest } from "../../core/facts/contracts.js";
import type { MemoryReceiptLike, MemoryStore } from "../../core/memory/contracts.js";
import { assertStructuredInput, type MemoryRepository, type StructuredMemoryInput } from "../../core/memory/storage-contract.js";
import type { CandidateSearchRequest, CandidateSearchResult, CandidateSearchStore } from "../../core/retrieval/contracts.js";
import { dispatchCandidateSearch } from "../../core/retrieval/readers.js";
import { OpenContinuityError } from "../../shared/errors.js";
import type { HistoryResult, ParsedHistoryInput, ParsedRecallInput, ParsedRememberInput, RecallResult } from "../../shared/types.js";
import type { DatabaseClient, DatabasePool, PostgresRecordContext, PostgresWriteContext } from "./contracts.js";
import { createPostgresCandidateReaders } from "./readers/index.js";
import { factGroupPostgres } from "./records/facts.js";
import { historyPostgres } from "./records/history.js";
import { listPostgres } from "./records/list.js";
import { assertPostgresSchemaVersion, migratePostgres } from "./schema.js";
import { forgetPostgres } from "./writes/forget.js";
import { duplicatePostgres } from "./writes/idempotency.js";
import { rememberPostgres } from "./writes/remember.js";
export type { DatabaseClient, DatabasePool } from "./contracts.js";


interface PostgresMemoryStoreOptions {
  autoMigrate?: boolean;
  ownsPool?: boolean;
}


export class PostgresMemoryStore implements MemoryStore, MemoryRepository, CandidateSearchStore {
  readonly candidateReaders = createPostgresCandidateReaders({
    rows: async (sql, values) => {
      await this.initialize();
      return (await this.query(sql, values)).rows;
    },
  });
  private ready?: Promise<void>;
  private readonly recordOperations: PostgresRecordContext = { initialize: () => this.initialize(), query: (sql, values) => this.query(sql, values) };
  private readonly writeOperations: PostgresWriteContext = { ...this.recordOperations, connect: () => this.connect(), rollback: client => this.rollback(client), isUniqueViolation: error => this.isUniqueViolation(error), readDuplicate: input => this.readDuplicate(input), storageError: error => this.storageError(error) };
  private readonly autoMigrate: boolean;
  private readonly ownsPool: boolean;

  constructor(private readonly pool: DatabasePool, options: PostgresMemoryStoreOptions = {}) {
    this.ownsPool = options.ownsPool ?? false;
    this.autoMigrate = options.autoMigrate !== false;
  }

  static fromConnectionString(connectionString: string, options: Omit<PostgresMemoryStoreOptions, "ownsPool"> = {}): PostgresMemoryStore {
    // Bound pool acquisition and server-side waits; these are not per-request cancellation.
    return new PostgresMemoryStore(new Pool({
      connectionString, max: 10, connectionTimeoutMillis: 2000,
      statement_timeout: 5000, lock_timeout: 2000
    }), { ...options, ownsPool: true });
  }

  async initialize(): Promise<void> {
    if (!this.ready) {
      const attempt = this.initializeDatabase();
      this.ready = attempt;
      void attempt.catch(() => { if (this.ready === attempt) this.ready = undefined; });
    }
    await this.ready;
  }

  async appendRemember(input: ParsedRememberInput): Promise<MemoryReceiptLike> { return rememberPostgres(this.writeOperations, input); }

  async appendForget(userId: string, agentId: string, memoryId: string, taskId?: string, includePrivate = false): Promise<MemoryReceiptLike> { return forgetPostgres(this.writeOperations, userId, agentId, memoryId, taskId, includePrivate); }

  async list(input: StructuredMemoryInput): Promise<RecallResult> { assertStructuredInput(input); return this.read(input); }

  async recall(input: ParsedRecallInput): Promise<RecallResult> {
    return input.query === undefined ? this.list(input as StructuredMemoryInput) : this.read(input);
  }

  private async read(input: ParsedRecallInput): Promise<RecallResult> { return listPostgres(this.recordOperations, input); }

  async searchCandidates(request: CandidateSearchRequest): Promise<CandidateSearchResult> {
    return dispatchCandidateSearch(request, this.candidateReaders);
  }

  async history(input: ParsedHistoryInput): Promise<HistoryResult> { return historyPostgres(this.recordOperations, input); }
  async readFactGroup(request: FactGroupRequest) { return factGroupPostgres(this.recordOperations, request); }

  async close(): Promise<void> { if (this.ownsPool) await this.pool.end?.(); }

  private async migrate(): Promise<void> {
    const client = await this.connect();
    let failed = false;
    try { await migratePostgres(client); }
    catch (error) { failed = true; throw error; }
    finally { client.release(failed ? true : undefined); }
  }

  private async initializeDatabase(): Promise<void> {
    try {
      if (this.autoMigrate) await this.migrate();
      else assertPostgresSchemaVersion((await this.query("SELECT version FROM open_continuity_schema_migrations", [])).rows);
    } catch (error) {
      if (error instanceof OpenContinuityError) throw error;
      throw this.storageError(error);
    }
  }

  private async query(text: string, values: unknown[]): Promise<QueryResult> {
    const client = await this.connect();
    try { return await client.query(text, values); } catch (error) { throw this.storageError(error); } finally { client.release(); }
  }

  private async readDuplicate(input: ParsedRememberInput): Promise<MemoryReceiptLike> { return duplicatePostgres(this.recordOperations, input); }

  private isUniqueViolation(error: unknown): boolean { return Boolean(error && typeof error === "object" && "code" in error && error.code === "23505"); }
  private async rollback(client: DatabaseClient): Promise<boolean> {
    try { await client.query("ROLLBACK"); return true; } catch { return false; }
  }
  private async connect(): Promise<DatabaseClient> {
    try { return await this.pool.connect(); } catch (error) { throw this.storageError(error); }
  }
  private storageError(error: unknown): OpenContinuityError {
    if (error instanceof OpenContinuityError) return error;
    return new OpenContinuityError("STORAGE_ERROR", "PostgreSQL operation failed", 500);
  }
}
