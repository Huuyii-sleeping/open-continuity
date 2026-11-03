import { expect, it } from "vitest";
import { resolveReadRuntimePolicy } from "../../../src/core/runtime/policy.js";
it("runtime policy: defaults and strict budget validation are independent of a database", () => {
  expect(resolveReadRuntimePolicy({})).toEqual({ defaultTimeoutMs: 1500, maxConcurrentRequests: 16, maxPendingReads: 8 });
  for (const policy of [{ maxPendingReads: 0 }, { defaultTimeoutMs: 9 }, { maxConcurrentRequests: NaN }, { defaultTimeoutMs: 30001 }]) expect(() => resolveReadRuntimePolicy(policy)).toThrow(expect.objectContaining({ code: "VALIDATION_ERROR" }));
  expect(Object.isFrozen(resolveReadRuntimePolicy({}))).toBe(true);
});
