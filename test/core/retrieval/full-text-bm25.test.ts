import { expect, it } from "vitest";
import { readerRouteFixture } from "../../helpers/reader-route-fixture.js";
import { routeActor } from "../../helpers/core-route-fixtures.js";
it("BM25 reader: ranks focused older text before newer diluted text with eligibility before top-K", async () => {
  const fixture = await readerRouteFixture();
  try {
    await fixture.write("fictional-diluted", "needle " + "fictional-filler ".repeat(100));
    const result = fixture.store.candidateReaders.full_text({ ...routeActor, query: "needle", limit: 1, requireUserConfirmed: true });
    expect(result.implementation).toBe("sqlite_fts5_bm25");
    expect(result.hits[0].memory.key).toBe("fictional-target");
    expect(result.hits[0]).toMatchObject({ rankMeaning: "relevance", score: { model: "fts5_bm25", direction: "lower_is_better" } });
  } finally { await fixture.close(); }
});
