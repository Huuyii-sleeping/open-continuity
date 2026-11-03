import { expect, it, vi } from "vitest";
import { forgetSqlite } from "../../src/storage/sqlite/writes/forget.js";
import type { SqliteForgetPort } from "../../src/storage/sqlite/contracts.js";
import type { SQLInputValue } from "node:sqlite";
it("SQLite forget port: invisible or missing memories produce no writes within the transaction", () => {
  const run = vi.fn(), getRequired = vi.fn(), get = vi.fn((_sql: string, _values: SQLInputValue[]) => undefined);
  const port: SqliteForgetPort = { run, getRequired, get, writeTransaction: operation => operation() };
  expect(() => forgetSqlite(port, "fictional-user", "fictional-reader", "fictional-hidden", "fictional-task")).toThrow(expect.objectContaining({ code: "MEMORY_NOT_FOUND" }));
  expect(get.mock.calls[0][1]).toEqual(["fictional-user", "fictional-hidden", "fictional-reader", "fictional-task", "fictional-task", 0]);
  expect(run).not.toHaveBeenCalled(); expect(getRequired).not.toHaveBeenCalled();
});
