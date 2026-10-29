import { expect, it } from "vitest";
import { emitReadReceipt } from "../../../src/core/runtime/observer.js";
import type { ReadRuntimeReceipt } from "../../../src/core/runtime/contracts.js";
const receipt = (): ReadRuntimeReceipt => ({ version: "bounded-reads-v1", operation: "recall", outcome: "completed", elapsedMs: 1, readsStarted: 1, activeRequests: 0, pendingReads: 0, stages: [] });
it("observer: exceptions and asynchronous rejection do not escape into the request", async () => {
  expect(() => emitReadReceipt(() => { throw new Error("fictional-observer-failure"); }, receipt())).not.toThrow();
  expect(() => emitReadReceipt(async () => { throw new Error("fictional-async-observer-failure"); }, receipt())).not.toThrow();
  await new Promise<void>(resolve => setImmediate(resolve));
});
it("observer: publishes immutable top-level metadata without a prompt payload", () => {
  const observed = receipt(); let captured: ReadRuntimeReceipt | undefined;
  emitReadReceipt(value => { captured = value; }, observed);
  expect(captured).toBe(observed); expect(captured).not.toHaveProperty("prompt");
  expect(Object.isFrozen(observed)).toBe(true);
});
