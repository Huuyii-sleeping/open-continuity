import { expect, it } from "vitest";
import { loadFactGroup } from "../../../src/core/facts/group-reader.js";
import { parseFactGroupRequest } from "../../../src/core/facts/contracts.js";
import { memoryFactSchema } from "../../../src/shared/types.js";
import { routeActor, routeMemory } from "../../helpers/core-route-fixtures.js";
const request = () => parseFactGroupRequest({ ...routeActor, group: "fictional-group", scope: "user", kind: "decision", limit: 1, requireUserConfirmed: true });
it("group reader: distinguishes unsupported and truncated proof from complete evidence", async () => {
  expect((await loadFactGroup({}, request(), "2031-01-01T00:00:00Z")).coverage).toBe("unsupported");
  const memory = routeMemory({ fact: memoryFactSchema.parse({ group: "fictional-group" }) });
  const result = await loadFactGroup({ readFactGroup: async () => ({ memories: [memory], truncated: true }) }, request(), "2031-01-01T00:00:00Z");
  expect(result.coverage).toBe("truncated"); expect(result.decisions.size).toBe(0);
});
it("group reader: rejects a hidden private companion returned by a provider", async () => {
  const memory = routeMemory({ sensitivity: "private", fact: memoryFactSchema.parse({ group: "fictional-group" }) });
  await expect(loadFactGroup({ readFactGroup: async () => ({ memories: [memory], truncated: false }) }, request(), "2031-01-01T00:00:00Z")).rejects.toMatchObject({ code: "STORAGE_ERROR" });
});
