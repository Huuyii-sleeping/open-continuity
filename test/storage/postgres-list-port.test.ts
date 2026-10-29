import { expect, it, vi } from "vitest";
import type { QueryResult } from "pg";
import { listPostgres } from "../../src/storage/postgres/records/list.js";
import { recallInputSchema } from "../../src/shared/types.js";
it("PostgreSQL list port: composes literal/filter eligibility before stable paging without interpolation", async () => {
  const query = vi.fn(async (_sql: string, _values: unknown[]): Promise<QueryResult> => ({ rows: [], fields: [], command: "SELECT", oid: 0, rowCount: 0 }));
  const input = recallInputSchema.parse({ userId: "fictional-user", agentId: "fictional-reader", key: "fictional-key", query: "fictional-needle", kind: "decision", limit: 2 });
  expect(await listPostgres({ initialize: async () => {}, query }, input)).toEqual({ memories: [], nextCursor: null });
  expect(query.mock.calls[0][1]).toEqual([input.userId, input.agentId, null, false, input.key, input.kind, input.query, 3]);
  expect(query.mock.calls[0][0]).not.toContain("fictional-key");
});
