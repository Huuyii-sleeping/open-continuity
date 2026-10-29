import { expect, it, vi } from "vitest";
import { guardMemoryStore, type GuardedRead } from "../../../src/core/runtime/store-guard.js";
import { InMemoryStore } from "../../../src/storage/inmemory/store.js";
import { routeActor } from "../../helpers/core-route-fixtures.js";
it("store guard: only registered readers are wrapped, and native and legacy calls retain their stages", async () => {
  const stages: string[] = [], read: GuardedRead = async (stage, start) => { stages.push(stage); return start(); };
  const base = new InMemoryStore();
  const guarded = guardMemoryStore({ appendRemember: base.appendRemember.bind(base), appendForget: base.appendForget.bind(base), recall: base.recall.bind(base), history: base.history.bind(base), candidateReaders: { full_text: base.candidateReaders.full_text } }, read);
  expect(Object.keys(guarded.candidateReaders!)).toEqual(["full_text"]);
  await guarded.candidateReaders!.full_text!({ ...routeActor, query: "needle" }); expect(stages).toEqual(["candidates"]);
  const search = vi.spyOn(base, "searchCandidates"), legacy = guardMemoryStore(base, read);
  await legacy.searchCandidates!({ ...routeActor, query: "needle", channel: "exact" }); expect(search).toHaveBeenCalledOnce(); expect(stages).toEqual(["candidates", "candidates"]);
});
