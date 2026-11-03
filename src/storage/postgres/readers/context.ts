import type { QueryResultRow } from "pg";

export interface PostgresCandidateContext {
  rows(sql: string, values: unknown[]): Promise<QueryResultRow[]>;
}
