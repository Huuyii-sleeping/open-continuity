import { expect, it } from "vitest";
import { projectEvidenceStatements } from "../../../src/core/answer/statements.js";
import { routeMemory, routePack } from "../../helpers/core-route-fixtures.js";
it("statement projection: preserves complete values independently and rejects altered pack values", () => {
  const memory = routeMemory({ value: { fictional: ["needle", "evidence"] } }), pack = routePack(memory);
  const result = projectEvidenceStatements(pack, new Map([[memory.id, memory]]));
  pack.items[0].value = "fictional altered value";
  expect(result.statements[0].value).toEqual({ fictional: ["needle", "evidence"] });
  expect(() => projectEvidenceStatements(pack, new Map([[memory.id, memory]]))).toThrow(expect.objectContaining({ code: "STORAGE_ERROR" }));
});
