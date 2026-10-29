import { expect, it, vi } from "vitest";
import { postgresFullTextCandidates } from "../../src/storage/postgres/readers/full-text.js";
it("PostgreSQL full-text port: explicitly declares substring fallback with bound eligibility and limit", async () => {
  const rows = vi.fn(async (_sql: string, _values: unknown[]) => []);
  const result = await postgresFullTextCandidates({ rows }, { userId: "fictional-user", agentId: "fictional-reader", query: "needle", taskId: "fictional-task", requireUserConfirmed: true, limit: 2 });
  expect(result).toMatchObject({ implementation: "postgres_substring_fallback", ordering: "updated_at_id", hits: [] });
  expect(rows.mock.calls[0][0]).toContain("strpos"); expect(rows.mock.calls[0][0]).toContain("user_confirmed = TRUE");
  expect(rows.mock.calls[0][1]).toEqual(["fictional-user", "fictional-reader", "fictional-task", false, "needle", 3]);
});
