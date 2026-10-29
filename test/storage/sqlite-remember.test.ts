import { expect, it, vi } from "vitest";
import type { SQLInputValue } from "node:sqlite";
import { rememberSqlite } from "../../src/storage/sqlite/writes/remember.js";
import { rememberInputSchema } from "../../src/shared/types.js";
import type { SqliteRememberPort } from "../../src/storage/sqlite/contracts.js";
it("SQLite remember port: a reused key with a different request cannot reach projection/event writes", () => {
  const input = rememberInputSchema.parse({ userId: "fictional-user", agentId: "fictional-reader", key: "fictional-key", value: "fictional value", kind: "decision", idempotencyKey: "fictional-idem" });
  const get = vi.fn((_sql: string, _values: SQLInputValue[]) => ({ event_type: "memory_forgotten" }));
  const getRequired = vi.fn(), writeFact = vi.fn();
  const port: SqliteRememberPort = { get, getRequired, writeFact, writeTransaction: operation => operation() };
  expect(() => rememberSqlite(port, input)).toThrow(expect.objectContaining({ code: "IDEMPOTENCY_CONFLICT" }));
  expect(get.mock.calls[0][1]).toEqual([input.userId, input.idempotencyKey]);
  expect(getRequired).not.toHaveBeenCalled(); expect(writeFact).not.toHaveBeenCalled();
});
