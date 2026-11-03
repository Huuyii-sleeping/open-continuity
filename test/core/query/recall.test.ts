import { expect, it, vi } from "vitest";
import { recallQueryStep } from "../../../src/core/query/recall.js";
import { routeInput } from "../../helpers/core-route-fixtures.js";
it("recall: passes identity, scope and confirmation to its reader without history or fact I/O", async () => {
  const recall = vi.fn(async () => ({ memories: [], nextCursor: null })), reviewFacts = vi.fn();
  const input = { ...routeInput(), scope: "task" as const, taskId: "fictional-task", includePrivate: false };
  await recallQueryStep({ recall, reviewFacts }, input, "fictional subquery", true);
  expect(recall).toHaveBeenCalledExactlyOnceWith({ userId: input.userId, agentId: input.agentId, taskId: input.taskId, scope: "task", query: "fictional subquery", key: input.key, kind: input.kind, includePrivate: false, limit: 100, cursor: undefined }, { requireUserConfirmed: true });
  expect(reviewFacts).not.toHaveBeenCalled();
});
