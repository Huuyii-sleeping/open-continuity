import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";
import { assertCoreContractMap, inspectContractMap, registeredCoreContracts } from "../../scripts/core-contract-map.js";
it("contract map: an omitted source or test is detected even if other routes still run", () => {
  const contract = registeredCoreContracts[0];
  expect(inspectContractMap([contract], path => path !== contract.test)).toMatchObject({ passed: false, missing: [{ responsibility: contract.responsibility, path: contract.test }] });
  expect(inspectContractMap([contract], path => path !== contract.implementation).passed).toBe(false);
});
it("contract map: empty/duplicate responsibilities cannot form an acceptance grid", () => {
  expect(() => inspectContractMap([], () => true)).toThrow();
  expect(() => inspectContractMap([registeredCoreContracts[0], registeredCoreContracts[0]], () => true)).toThrow();
});
it("contract map: all registered responsibilities exist in this repository", () => {
  expect(assertCoreContractMap(fileURLToPath(new URL("../../", import.meta.url))).passed).toBe(true);
});
