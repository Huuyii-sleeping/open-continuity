import type { SQLInputValue } from "node:sqlite";
import type { OpenContinuityError } from "../../../shared/errors.js";
import type { SqliteRow } from "../row-mapping.js";

/** Readers can read rows but cannot write, commit, migrate or close the database. */
export interface SqliteCandidateContext {
  lexicalIndexVersion?(): "json-literal-values-v1" | undefined;
  assertOpen(): void;
  all(sql: string, values: SQLInputValue[]): SqliteRow[];
  storageError(error: unknown): OpenContinuityError;
}
