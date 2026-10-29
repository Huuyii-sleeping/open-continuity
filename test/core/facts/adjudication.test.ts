import { expect, it } from "vitest";
import { assessFactGroup } from "../../../src/core/facts/adjudication.js";
import { memoryFactSchema } from "../../../src/shared/types.js";
import { routeMemory } from "../../helpers/core-route-fixtures.js";
it("adjudication: unequal visible values conflict; a verified replacement excludes exactly its target", () => {
  const old = routeMemory({ value: "fictional old", fact: memoryFactSchema.parse({ group: "fictional-group" }) });
  const next = routeMemory({ id: "00000000-0000-4000-8000-000000000002", sourceEventId: "10000000-0000-4000-8000-000000000002", value: "fictional new", fact: memoryFactSchema.parse({ group: "fictional-group" }) });
  expect([...assessFactGroup([old, next], "2031-01-01T00:00:00Z").values()].every(decision => decision.status === "conflict" && !decision.usable)).toBe(true);
  next.fact = memoryFactSchema.parse({ group: "fictional-group", supersedes: [{ memoryId: old.id, sourceEventId: old.sourceEventId, version: old.version }] });
  const decisions = assessFactGroup([old, next], "2031-01-01T00:00:00Z"); expect(decisions.get(old.id)?.status).toBe("superseded"); expect(decisions.get(next.id)?.usable).toBe(true);
});
