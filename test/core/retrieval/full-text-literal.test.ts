import { expect, it } from "vitest";
import { readerRouteFixture } from "../../helpers/reader-route-fixture.js";
import { routeActor } from "../../helpers/core-route-fixtures.js";
it("short literal reader: returns stable matches and preserves every mixed-query anchor", async () => {
  const fixture = await readerRouteFixture();
  try {
    await fixture.write("fictional-short-a", "xy needle"); await fixture.write("fictional-short-b", "xy filler");
    const request = { ...routeActor, query: "xy", requireUserConfirmed: true };
    const a = fixture.store.candidateReaders.full_text(request), b = fixture.store.candidateReaders.full_text(request);
    expect(a.implementation).toBe("sqlite_literal_fallback"); expect(a.hits.map(hit => hit.memory.id)).toEqual(b.hits.map(hit => hit.memory.id));
    const mixed = fixture.store.candidateReaders.full_text({ ...request, query: "xy needle" });
    expect(mixed.hits.map(hit => hit.memory.key)).toEqual(["fictional-short-a"]);
  } finally { await fixture.close(); }
});
