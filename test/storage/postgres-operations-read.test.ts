import { expect, it, vi } from "vitest";
import type { QueryResult } from "pg";
import { historyPostgres } from "../../src/storage/postgres/records/history.js";
import { historyInputSchema } from "../../src/shared/types.js";
import type { PostgresRecordContext } from "../../src/storage/postgres/contracts.js";
it("PostgreSQL history port: only reads with bound actor/task/private and limit values", async () => {
  const query = vi.fn(async (_sql: string, _values: unknown[]): Promise<QueryResult> => ({ rows: [], rowCount: 0, command: "SELECT", fields: [], oid: 0 }));
  const port: PostgresRecordContext = { initialize: async () => {}, query };
  const input = historyInputSchema.parse({ userId: "fictional-user", agentId: "fictional-reader", taskId: "fictional-task", limit: 2 });
  expect(await historyPostgres(port, input)).toEqual({ events: [], nextCursor: null });
  expect(query.mock.calls[0][1]).toEqual([input.userId, input.agentId, input.taskId, false, 3]);
});
