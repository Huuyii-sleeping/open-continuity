import type { QueryResult } from "pg";
import type { MemoryReceiptLike } from "../../core/memory/contracts.js";
import type { OpenContinuityError } from "../../shared/errors.js";
import type { ParsedRememberInput } from "../../shared/types.js";
export interface DatabaseClient {
  query(text: string, values?: unknown[]): Promise<QueryResult>;
  /** Custom pool wrappers must forward destroy=true; uncertain sessions cannot be reused. */
  release(destroy?: boolean | Error): void;
}
export interface DatabasePool {
  connect(): Promise<DatabaseClient>;
  end?(): Promise<void>;
}
export interface PostgresRecordContext { initialize(): Promise<void>; query(text: string, values: unknown[]): Promise<QueryResult>; }
export interface PostgresWriteContext extends PostgresRecordContext { connect(): Promise<DatabaseClient>; rollback(client: DatabaseClient): Promise<boolean>; isUniqueViolation(error: unknown): boolean; readDuplicate(input: ParsedRememberInput): Promise<MemoryReceiptLike>; storageError(error: unknown): OpenContinuityError; }
export type PostgresRememberPort = Pick<PostgresWriteContext, "initialize" | "connect" | "rollback" | "isUniqueViolation" | "readDuplicate" | "storageError">;
export type PostgresForgetPort = Pick<PostgresWriteContext, "initialize" | "connect" | "rollback" | "storageError">;
