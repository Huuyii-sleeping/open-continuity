import { expect, it, vi } from "vitest";
import type { SQLInputValue } from "node:sqlite";
import { listSqlite } from "../../src/storage/sqlite/records/list.js";
import { recallInputSchema } from "../../src/shared/types.js";
import type { SqliteRecordContext } from "../../src/storage/sqlite/contracts.js";
import { OpenContinuityError } from "../../src/shared/errors.js";
it("SQLite list port: structured filters stay parameterized with eligible one-row lookahead", () => {
  const all = vi.fn((_sql: string, _values: SQLInputValue[]) => []);
  const context: SqliteRecordContext = { assertOpen() {}, all, get: vi.fn(), storageError: () => new OpenContinuityError("STORAGE_ERROR", "fictional", 500) };
  const input = recallInputSchema.parse({ userId: "fictional-user", agentId: "fictional-reader", scope: "user", key: "fictional-key", kind: "decision", limit: 2 });
  expect(listSqlite(context, input)).toEqual({ memories: [], nextCursor: null });
  expect(all.mock.calls[0][1]).toEqual([input.userId, input.agentId, null, null, 0, "user", "fictional-key", "decision", 3]);
  expect(all.mock.calls[0][0]).not.toContain("fictional-key");
});
