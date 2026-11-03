import { expect, it, vi } from "vitest";
import type { QueryResult } from "pg";
import { rememberPostgres } from "../../src/storage/postgres/writes/remember.js";
import type { DatabaseClient, PostgresRememberPort } from "../../src/storage/postgres/contracts.js";
import { rememberInputSchema } from "../../src/shared/types.js";
import { OpenContinuityError } from "../../src/shared/errors.js";
it("PostgreSQL remember port: conflicting idempotency stops before state mutation and rolls back", async () => {
  const input = rememberInputSchema.parse({ userId: "fictional-user", agentId: "fictional-reader", key: "fictional-key", value: "fictional value", kind: "decision", idempotencyKey: "fictional-idem" });
  const query = vi.fn(async (sql: string): Promise<QueryResult> => ({ rows: sql.includes("SELECT * FROM memory_events") ? [{ event_type: "memory_forgotten" }] : [], rowCount: 0, command: "SELECT", fields: [], oid: 0 }));
  const release = vi.fn(), client: DatabaseClient = { query, release };
  const rollback = vi.fn(async () => true), readDuplicate = vi.fn();
  const port: PostgresRememberPort = { initialize: async () => {}, connect: async () => client, rollback, readDuplicate, isUniqueViolation: () => false, storageError: () => new OpenContinuityError("STORAGE_ERROR", "fictional", 500) };
  await expect(rememberPostgres(port, input)).rejects.toMatchObject({ code: "IDEMPOTENCY_CONFLICT" });
  expect(query.mock.calls.some(([sql]) => /INSERT|UPDATE|DELETE|COMMIT/.test(sql))).toBe(false);
  expect(rollback).toHaveBeenCalledExactlyOnceWith(client); expect(release).toHaveBeenCalledExactlyOnceWith(undefined);
  expect(readDuplicate).not.toHaveBeenCalled();
});
