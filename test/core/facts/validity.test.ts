import { expect, it } from "vitest";
import { temporal } from "../../../src/core/facts/validity.js";
import { memoryFactSchema } from "../../../src/shared/types.js";
import { routeMemory } from "../../helpers/core-route-fixtures.js";
it("validity: uses a closed start and open end interval", () => {
  const start = "2031-01-01T00:00:00.000Z", end = "2032-01-01T00:00:00.000Z";
  const memory = routeMemory({ fact: memoryFactSchema.parse({ group: "fictional-group", validFrom: start, validUntil: end }) });
  expect(temporal(memory, Date.parse(start) - 1)?.status).toBe("not_yet_valid");
  expect(temporal(memory, Date.parse(start))).toBeUndefined();
  expect(temporal(memory, Date.parse(end))?.status).toBe("expired");
});
