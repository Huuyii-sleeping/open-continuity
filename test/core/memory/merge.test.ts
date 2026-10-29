import { expect, it } from "vitest";
import { mergeJsonObjects } from "../../../src/core/memory/merge.js";
it("JSON merge: retains sibling fields, replaces arrays and treats prototype names as data", () => {
  const current = { fictional: { retained: true, overwritten: 1 }, list: [1, 2] };
  const patch = JSON.parse('{"fictional":{"overwritten":2},"list":[3],"__proto__":{"fictionalPollution":true}}') as Record<string, unknown>;
  const merged = mergeJsonObjects(current, patch);
  expect(merged.fictional).toEqual({ retained: true, overwritten: 2 });
  expect(merged.list).toEqual([3]); expect(Object.hasOwn(merged, "__proto__")).toBe(true);
  expect(Object.getPrototypeOf(merged)).toBe(Object.prototype); expect(Object.hasOwn(Object.prototype, "fictionalPollution")).toBe(false);
  expect(current.fictional.overwritten).toBe(1);
});
