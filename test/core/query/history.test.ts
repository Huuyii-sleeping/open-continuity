import { expect, it, vi } from "vitest";
import { loadQueryHistory } from "../../../src/core/query/history.js";
import type { EvidenceAccumulator } from "../../../src/core/query/contracts.js";
import type { ParsedHistoryInput } from "../../../src/shared/types.js";
import { routeInput, routeMemory, routeQueryPolicy } from "../../helpers/core-route-fixtures.js";
it("history: allocates one global event budget over ranked targets and preserves scope", async () => {
  const items = [routeMemory(), routeMemory({ id: "fictional-second" }), routeMemory({ id: "fictional-third" })];
  const map = new Map<string, EvidenceAccumulator>(items.map((memory, i) => [memory.id, { memory, score: 3 - i, matchedQueries: new Set(), stepIds: new Set() }]));
  const history = vi.fn(async (_input: ParsedHistoryInput) => ({ events: [], nextCursor: "fictional-next-page" }));
  const result = await loadQueryHistory({ history }, { ...routeQueryPolicy, maxSubqueries: 2 }, routeInput(), map);
  expect(history.mock.calls).toHaveLength(2);
  expect(history.mock.calls.map(call => call[0].limit)).toEqual([3, 2]);
  expect(history.mock.calls[0][0]).toMatchObject({ userId: routeInput().userId, agentId: routeInput().agentId, memoryId: items[0].id, includePrivate: false });
  expect(result.truncatedMemoryIds).toEqual(new Set(items.map(memory => memory.id)));
});
it("history: an empty candidate set never touches the history reader", async () => {
  const history = vi.fn(async () => ({ events: [], nextCursor: null }));
  expect((await loadQueryHistory({ history }, routeQueryPolicy, routeInput(), new Map())).events).toEqual([]);
  expect(history).not.toHaveBeenCalled();
});
