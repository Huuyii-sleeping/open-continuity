import { expect, it } from "vitest";
import { readerRouteFixture } from "../../helpers/reader-route-fixture.js";
import { routeActor } from "../../helpers/core-route-fixtures.js";
it("structured reader: returns filter qualification rather than inventing query relevance", async () => {
  const fixture = await readerRouteFixture();
  try {
    const result = fixture.store.candidateReaders.structured({ ...routeActor, query: "fictional-absent", kind: "decision", limit: 1, requireUserConfirmed: true });
    expect(result.hits.map(hit => hit.memory.key)).toEqual(["fictional-target"]);
    expect(result.hits[0]).toMatchObject({ rankMeaning: "filter_order", score: { model: "none", value: null } });
  } finally { await fixture.close(); }
});
