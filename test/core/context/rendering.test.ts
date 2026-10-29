import { expect, it } from "vitest";
import { renderMemory, estimateContextTokens } from "../../../src/core/context/rendering.js";
import { routeMemory } from "../../helpers/core-route-fixtures.js";
it("Context rendering: retains structured JSON values and counts UTF-8 rather than character count", () => {
  const memory = routeMemory({ value: { fictional: ["虚构值", 3] } }), text = renderMemory(memory);
  expect(JSON.parse(text).value).toEqual(memory.value);
  expect(estimateContextTokens("虚构值")).toBe(3); expect(estimateContextTokens("")).toBe(0);
});
