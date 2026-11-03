import { expect, it } from "vitest";
import { readerRouteFixture } from "../../helpers/reader-route-fixture.js";
import { routeActor } from "../../helpers/core-route-fixtures.js";
it("exact reader: filters identity/private/confirmation before returning its bounded key match", async () => {
  const fixture = await readerRouteFixture();
  try {
    const result = fixture.store.candidateReaders.exact({ ...routeActor, query: "fictional-target", limit: 1, requireUserConfirmed: true });
    expect(result.hits.map(hit => hit.memory.key)).toEqual(["fictional-target"]);
    expect(fixture.store.candidateReaders.exact({ ...routeActor, query: "fictional-private" }).hits).toEqual([]);
    expect(fixture.store.candidateReaders.exact({ ...routeActor, query: "fictional-pending", requireUserConfirmed: true }).hits).toEqual([]);
  } finally { await fixture.close(); }
});
