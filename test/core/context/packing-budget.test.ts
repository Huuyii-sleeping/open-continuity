import { expect, it } from "vitest";
import { createPackingState } from "../../../src/core/context/packing/budget.js";
import { renderMemory } from "../../../src/core/context/rendering.js";
import { memoryFactSchema } from "../../../src/shared/types.js";
import { routeCandidate } from "../../helpers/core-route-fixtures.js";
it("packing budget: measures UTF-8 content including separators at the whole-pack boundary", () => {
  const a = routeCandidate({ id: "fictional-a", value: "虚构内容甲" }), b = routeCandidate({ id: "fictional-b", value: "虚构内容乙" });
  const text = renderMemory(a.memory) + "\n" + renderMemory(b.memory);
  const tokens = Math.ceil(Buffer.byteLength(text, "utf8") / 4);
  const state = createPackingState(tokens, 2); expect(state.append(a)).toBe(true); expect(state.append(b)).toBe(true); expect(state.usedTokens).toBe(tokens);
  const limited = createPackingState(tokens - 1, 2); limited.append(a); expect(limited.append(b)).toBe(false);
});
it("packing budget: unresolved facts are rejected before spending token or count capacity", () => {
  const state = createPackingState(4096, 1);
  expect(state.append(routeCandidate({ fact: memoryFactSchema.parse({ group: "fictional-group" }) }))).toBe(false);
  expect(state.usedTokens).toBe(0); expect(state.hasCapacity()).toBe(true);
  expect(state.omitted[0].reason).toBe("fact_unresolved");
});
