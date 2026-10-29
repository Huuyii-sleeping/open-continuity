import type { SQLInputValue } from "node:sqlite";
import type { OpenContinuityError } from "../../shared/errors.js";
import type { MemoryEvent, MemoryFact } from "../../shared/types.js";
import type { SqliteRow } from "./row-mapping.js";
export interface SqliteRecordContext { assertOpen(): void; all(sql: string, values: SQLInputValue[]): SqliteRow[]; get(sql: string, values: SQLInputValue[]): SqliteRow | undefined; storageError(error: unknown): OpenContinuityError; }
export interface SqliteWriteContext extends SqliteRecordContext { run(sql: string, values: SQLInputValue[]): void; getRequired(sql: string, values: SQLInputValue[]): SqliteRow; writeTransaction<T>(operation: () => T): T; writeFact(memoryId: string, eventId: string, fact?: MemoryFact): void; importEvent(event: MemoryEvent): void; }
export type SqliteRememberPort = Pick<SqliteWriteContext, "get" | "getRequired" | "writeTransaction" | "writeFact">;
export type SqliteForgetPort = Pick<SqliteWriteContext, "get" | "getRequired" | "run" | "writeTransaction">;
