import { expect, it, vi } from "vitest";
import { postgresExactCandidates } from "../../src/storage/postgres/readers/exact.js";
it("PostgreSQL exact reader: key mismatch skips database I/O, literal keys stay bound", async () => {
  const rows = vi.fn(async (_sql: string, _values: unknown[]) => []);
  expect((await postgresExactCandidates({ rows }, { userId: "fictional-user", agentId: "fictional-reader", key: "fictional-key", query: "fictional-other" })).status).toBe("skipped"); expect(rows).not.toHaveBeenCalled();
  await postgresExactCandidates({ rows }, { userId: "fictional-user", agentId: "fictional-reader", query: "fictional-key", limit: 2 });
  expect(rows.mock.calls[0][1]).toEqual(["fictional-user", "fictional-reader", null, false, "fictional-key", 3]);
});
