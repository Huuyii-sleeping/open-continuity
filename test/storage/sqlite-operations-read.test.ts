import { expect, it, vi } from "vitest";
import { historySqlite } from "../../src/storage/sqlite/records/history.js";
import { historyInputSchema } from "../../src/shared/types.js";
import type { SqliteRecordContext } from "../../src/storage/sqlite/contracts.js";
import { OpenContinuityError } from "../../src/shared/errors.js";
import type { SQLInputValue } from "node:sqlite";
it("SQLite history port: preserves visibility parameters and fetches only one lookahead row", () => {
  const all = vi.fn((_sql: string, _values: SQLInputValue[]) => []), input = historyInputSchema.parse({ userId: "fictional-user", agentId: "fictional-reader", taskId: "fictional-task", limit: 2 });
  const port: SqliteRecordContext = { assertOpen() {}, all, get: vi.fn(), storageError: () => new OpenContinuityError("STORAGE_ERROR", "fictional", 500) };
  expect(historySqlite(port, input)).toEqual({ events: [], nextCursor: null });
  expect(all.mock.calls[0][1]).toEqual([input.userId, input.agentId, input.taskId, input.taskId, 0, 3]);
});
