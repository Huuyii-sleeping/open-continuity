import { expect, it } from "vitest";
import { orderDenseWindow } from "../../../src/core/retrieval/dense/reranking/order.js";
import { chooseRerankingSelection } from "../../../src/core/retrieval/dense/reranking/selection.js";
import type { RelevanceReceipt } from "../../../src/core/retrieval/reranking/contracts.js";
import type { DenseSupportSelection } from "../../../src/core/retrieval/dense/rescue/contracts.js";
import { routeMemory as memory } from "../../helpers/core-route-fixtures.js";
it("uses relevance before cosine and then stable time/id ties", () => {
  const a = { memory: memory({ id: "a", updatedAt: "2026-01-01T00:00:00.000Z" }), score: .9 }, b = { memory: memory({ id: "b", updatedAt: "2026-01-02T00:00:00.000Z" }), score: .7 };
  const receipt: RelevanceReceipt = { version: "cross-encoder-relevance-v1", modelFingerprint: "a".repeat(64), policyFingerprint: "b".repeat(64), runtimeFingerprint: "c".repeat(64),
    queryFingerprint: "d".repeat(64), accessFingerprint: "e".repeat(64), meaning: "relative_query_document_relevance_logit", status: "scored", cache: "miss",
    scores: [a, b].map((entry, i) => ({ memoryId: entry.memory.id, sourceEventId: entry.memory.sourceEventId, memoryVersion: 1, contentFingerprint: "f".repeat(64), value: i })) };
  expect(orderDenseWindow([a, b], receipt).map(entry => entry.memory.id)).toEqual(["b", "a"]);
  receipt.scores[0]!.value = 1; expect(orderDenseWindow([a, b], receipt).map(entry => entry.memory.id)).toEqual(["a", "b"]);
  a.score = .7; expect(orderDenseWindow([a, b], receipt).map(entry => entry.memory.id)).toEqual(["b", "a"]);
  expect(() => orderDenseWindow([a, b], { ...receipt, scores: [] })).toThrow(/ordering/);
});
it("retains validated baseline evidence only on genuine rejection and refuses unavailable selection", () => {
  const empty: DenseSupportSelection = { accepted: [], pairs: [], reversePairs: [], reason: "pair_rejected" };
  const existing: DenseSupportSelection = { ...empty, accepted: [{ memory: memory(), score: .8 }], reason: "admitted" };
  expect(chooseRerankingSelection(existing, empty).route).toBe("baseline"); expect(chooseRerankingSelection(existing, existing).route).toBe("reranked");
  expect(() => chooseRerankingSelection(existing, { ...empty, reason: "verification_unavailable" })).toThrow(/Unavailable/);
});
