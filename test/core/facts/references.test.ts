import { expect, it } from "vitest";
import { resolveFactReferences } from "../../../src/core/facts/references.js";
import { memoryFactSchema } from "../../../src/shared/types.js";
import { routeMemory } from "../../helpers/core-route-fixtures.js";
it("references: a replacement must name the exact event and version", () => {
  const old = routeMemory({ fact: memoryFactSchema.parse({ group: "fictional-group" }) });
  const newer = routeMemory({ id: "fictional-newer", fact: memoryFactSchema.parse({ group: "fictional-group", supersedes: [{ memoryId: old.id, sourceEventId: old.sourceEventId, version: 1 }] }) });
  const all = [old, newer];
  expect(resolveFactReferences(all, new Map(all.map(memory => [memory.id, memory])))).toMatchObject({ unresolved: false, cyclic: false, replaced: new Set([old.id]) });
  expect(resolveFactReferences([newer], new Map([[old.id, { ...old, version: 2 }]]))).toMatchObject({ unresolved: true });
});
