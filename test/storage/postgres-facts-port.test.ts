import { expect, it, vi } from "vitest";
import type { QueryResult } from "pg";
import { factGroupPostgres } from "../../src/storage/postgres/records/facts.js";
it("PostgreSQL facts port: owner partition, private and confirmation filters precede bounded reads", async () => {
  const query = vi.fn(async (_sql: string, _values: unknown[]): Promise<QueryResult> => ({ rows: [], fields: [], command: "SELECT", oid: 0, rowCount: 0 }));
  expect(await factGroupPostgres({ initialize: async () => {}, query }, { userId: "fictional-user", agentId: "fictional-reader", scope: "agent", kind: "decision", group: "fictional-group", requireUserConfirmed: true, limit: 2 })).toEqual({ memories: [], truncated: false });
  expect(query.mock.calls[0][1]).toEqual(["fictional-user", "agent", "fictional-reader", "decision", "fictional-group", false, 3]);
  expect(query.mock.calls[0][0]).toContain("user_confirmed = TRUE");
});
