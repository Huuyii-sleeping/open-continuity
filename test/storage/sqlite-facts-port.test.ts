import { expect, it, vi } from "vitest";
import type { SQLInputValue } from "node:sqlite";
import { factGroupSqlite } from "../../src/storage/sqlite/records/facts.js";
import type { SqliteRecordContext } from "../../src/storage/sqlite/contracts.js";
import { OpenContinuityError } from "../../src/shared/errors.js";
it("SQLite facts port: partitions agent groups by owner and confirmation before limit", () => {
  const all = vi.fn((_sql: string, _values: SQLInputValue[]) => []);
  const context: SqliteRecordContext = { assertOpen() {}, all, get: vi.fn(), storageError: () => new OpenContinuityError("STORAGE_ERROR", "fictional", 500) };
  expect(factGroupSqlite(context, { userId: "fictional-user", agentId: "fictional-reader", scope: "agent", kind: "decision", group: "fictional-group", requireUserConfirmed: true, limit: 2 })).toEqual({ memories: [], truncated: false });
  expect(all.mock.calls[0][1]).toEqual(["fictional-user", "agent", "fictional-reader", "decision", "fictional-group", 0, 3]);
  expect(all.mock.calls[0][0]).toContain("user_confirmed = 1");
});
