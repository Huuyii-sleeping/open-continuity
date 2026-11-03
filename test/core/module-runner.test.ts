import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";
import { coreTestCatalog, selectModuleTests } from "../../scripts/core-test-catalog.js";
import { summarizeModuleTests } from "../../scripts/core-test-report.js";
const root = fileURLToPath(new URL("../../", import.meta.url));
const selected = [{ module: "query", route: "recall", files: ["test/core/query/recall.test.ts"] }];
const report = (status: string, assertions = true) => ({ testResults: [{ name: root + selected[0].files[0], status: status === "failed" ? "failed" : "passed", assertionResults: assertions ? [{ fullName: "fictional recall contract", status }] : [] }] });
it("module runner: selects one actual module route and rejects invalid/empty selections", () => {
  const catalog = coreTestCatalog(root);
  expect(selectModuleTests(catalog, "query", "recall")).toEqual(selected);
  for (const [module, route] of [["unknown", undefined], ["", undefined], [undefined, "recall"], ["query", ""]]) expect(() => selectModuleTests(catalog, module, route)).toThrow();
  expect(catalog.flatMap(row => row.files).length).toBe(new Set(catalog.flatMap(row => row.files)).size);
});
it("module runner: preserves failed and skipped outcomes instead of reporting them as passed", () => {
  expect(summarizeModuleTests(root, selected, report("failed"))).toMatchObject({ accepted: false, rows: [{ status: "failed", failed: 1 }] });
  expect(summarizeModuleTests(root, selected, report("pending"))).toMatchObject({ accepted: false, rows: [{ status: "skipped", skipped: 1 }] });
});
it("module runner: an empty grid, zero assertions, missing files or duplicate rows cannot pass", () => {
  expect(() => summarizeModuleTests(root, [], report("passed"))).toThrow();
  expect(summarizeModuleTests(root, selected, report("passed", false)).accepted).toBe(false);
  expect(summarizeModuleTests(root, selected, { testResults: [] }).accepted).toBe(false);
  const raw = report("passed"); raw.testResults.push(raw.testResults[0]);
  expect(() => summarizeModuleTests(root, selected, raw)).toThrow();
});
it("module runner: an empty file cannot borrow another file's passing assertions", () => {
  const grid = [{ module: "fictional", route: "combined", files: ["test/fictional-a.test.ts", "test/fictional-b.test.ts"] }];
  const raw = { testResults: [{ name: root + grid[0].files[0], status: "passed", assertionResults: [{ fullName: "fictional pass", status: "passed" }] }, { name: root + grid[0].files[1], status: "passed", assertionResults: [] }] };
  expect(summarizeModuleTests(root, grid, raw)).toMatchObject({ accepted: false, rows: [{ status: "unverified", empty: [grid[0].files[1]] }] });
});
it("module runner: duplicated selection and invented status/negative latency are rejected", () => {
  expect(() => summarizeModuleTests(root, [...selected, ...selected], report("passed"))).toThrow();
  const unknown = report("passed"); unknown.testResults[0].status = "fictional-success";
  expect(() => summarizeModuleTests(root, selected, unknown)).toThrow();
  expect(() => summarizeModuleTests(root, selected, { testResults: [{ name: root + selected[0].files[0], status: "passed", assertionResults: [{ fullName: "fictional", status: "passed", duration: -1 }] }] })).toThrow();
});
it("module runner: skipped/pending file status cannot contain executed assertions", () => {
  for (const status of ["skipped", "pending"]) {
    const raw = report("passed"); raw.testResults[0].status = status;
    expect(() => summarizeModuleTests(root, selected, raw)).toThrow();
  }
});
