import { expect, it } from "vitest";
import { citationFor } from "../../../src/core/answer/citations.js";
import { routePack } from "../../helpers/core-route-fixtures.js";
it("citations: value, source event and version each bind citation identity", () => {
  const item = routePack().items[0], citation = citationFor(item);
  for (const changed of [{ ...item, value: "fictional changed value" }, { ...item, sourceEventId: "fictional-new-event" }, { ...item, version: 2 }]) expect(citationFor(changed).id).not.toBe(citation.id);
});
it("citations: invalid JSON values cannot be cited", () => {
  expect(() => citationFor({ ...routePack().items[0], value: NaN })).toThrow(expect.objectContaining({ code: "STORAGE_ERROR" }));
});
