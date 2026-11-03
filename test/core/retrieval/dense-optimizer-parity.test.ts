import { expect, it } from "vitest";
import { DenseRetriever } from "../../../src/core/retrieval/dense/retriever.js";
import { denseActor, denseAdmission, denseFixture } from "../../helpers/dense-fixture.js";
it("preserves full candidate scores and ranks across legacy scan, cold projection and warm cache", async () => {
  const f = denseFixture({ mode: "hybrid" }, async (texts, mode) => texts.map(text => {
    const angle = mode === "query" ? .2 : Number(text.split(" ").at(-1)) * .17;
    return [Math.cos(angle), Math.sin(angle)];
  }));
  const legacy = new DenseRetriever({ model: f.index.model, revision: () => f.index.revision(), pending: f.index.pending.bind(f.index), commit: f.index.commit.bind(f.index),
    coverage: f.index.coverage.bind(f.index), scan: f.index.scan.bind(f.index), population: f.index.population.bind(f.index) }, f.provider, { mode: "hybrid", admission: denseAdmission });
  try {
    for (let i = 0; i < 110; i++) await f.remember(`fictional fact ${i}`);
    await f.service.synchronizeDenseIndex(denseActor); await f.service.synchronizeDenseIndex(denseActor);
    const request = { ...denseActor, query: "fictional query", limit: 50 };
    const before = await legacy.retrieve(request, 0), cold = await f.dense.retrieve(request, 0), warm = await f.dense.retrieve(request, 0);
    expect(before.status).toBe("ok"); expect(cold.hits).toEqual(before.hits); expect(warm.hits).toEqual(before.hits);
    expect(cold.dense?.ranking?.cache).toBe("miss"); expect(warm.dense?.ranking?.cache).toBe("hit");
  } finally { await legacy.close(); await f.cleanup(); }
});
