import { expect, it, vi } from "vitest";
import { revalidateQueryFacts } from "../../../src/core/query/fact-review.js";
import { ReadDeadline } from "../../../src/core/runtime/deadline.js";
import { memoryFactSchema } from "../../../src/shared/types.js";
import type { ParsedRecallInput, ResolvedMemory } from "../../../src/shared/types.js";
import type { EvidenceAccumulator } from "../../../src/core/query/contracts.js";
import { routeInput, routeMemory } from "../../helpers/core-route-fixtures.js";
it("fact-review: timeout removes annotated evidence and preserves ordinary memories", async () => {
  const plain = routeMemory(), fact = routeMemory({ id: "fictional-claim", fact: memoryFactSchema.parse({ group: "fictional-group" }) });
  const evidence = new Map<string, EvidenceAccumulator>([plain, fact].map(memory => [memory.id, { memory, score: 1, matchedQueries: new Set(), stepIds: new Set() }]));
  let clock = 0;
  const reviewFacts = vi.fn(async (_input: ParsedRecallInput, _memories: ResolvedMemory[], _confirmed?: boolean) => { clock = 11; return { ranked: [], review: { policy: "explicit-facts-v1" as const, evaluatedAt: "2031-01-01T00:00:00Z", groupLimit: 100, reviewedGroups: 1, omitted: [] } }; });
  const result = await revalidateQueryFacts({ recall: vi.fn(), reviewFacts }, new ReadDeadline(10, () => clock), routeInput(), evidence, true);
  expect(result.timedOut).toBe(true);
  expect([...evidence.keys()]).toEqual([plain.id]);
  expect(reviewFacts.mock.calls[0][2]).toBe(true);
});
