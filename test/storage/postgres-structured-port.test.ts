import { expect, it, vi } from "vitest";
import { postgresStructuredCandidates } from "../../src/storage/postgres/readers/structured.js";
it("PostgreSQL structured reader: requires explicit filters and never changes text into matching criteria", async () => {
  const rows = vi.fn(async (_sql: string, _values: unknown[]) => []), actor = { userId: "fictional-user", agentId: "fictional-reader" };
  expect((await postgresStructuredCandidates({ rows }, { ...actor, query: "fictional needle" })).status).toBe("skipped"); expect(rows).not.toHaveBeenCalled();
  await postgresStructuredCandidates({ rows }, { ...actor, kind: "decision", query: "fictional needle", requireUserConfirmed: true, limit: 2 });
  expect(rows.mock.calls[0][1]).toEqual([actor.userId, actor.agentId, null, false, "decision", 3]);
  expect(rows.mock.calls[0][0]).not.toContain("strpos");
});
