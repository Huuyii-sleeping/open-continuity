import { resolve } from "node:path";
import { z } from "zod";
import type { ModuleTestRoute } from "./core-test-catalog.js";
const assertionSchema = z.object({ fullName: z.string().min(1), status: z.enum(["passed", "failed", "pending", "skipped", "todo", "disabled"]), duration: z.number().finite().nonnegative().nullable().optional() }).passthrough();
const reportSchema = z.object({ testResults: z.array(z.object({ name: z.string().min(1), status: z.enum(["passed", "failed", "pending", "skipped"]).optional(), assertionResults: z.array(assertionSchema) }).passthrough()) }).passthrough();
export function summarizeModuleTests(root: string, selected: ModuleTestRoute[], raw: unknown) {
  if (!selected.length || selected.some(item => !item.files.length)) throw new Error("Cannot accept an empty test grid");
  if (new Set(selected.map(row => row.module + "/" + row.route)).size !== selected.length || new Set(selected.flatMap(row => row.files)).size !== selected.flatMap(row => row.files).length) throw new Error("Duplicate selected routes or test files");
  const report = reportSchema.parse(raw);
  const files = new Map(report.testResults.map(item => [resolve(item.name), item]));
  if (files.size !== report.testResults.length) throw new Error("Duplicate test file results");
  const expectedFiles = new Set(selected.flatMap(row => row.files).map(file => resolve(root, file)));
  if ([...files.keys()].some(file => !expectedFiles.has(file))) throw new Error("Unexpected test file in result grid");
  const rows = selected.map(item => {
    const observed = item.files.map(file => files.get(resolve(root, file)));
    const assertions = observed.flatMap(file => file?.assertionResults ?? []);
    for (const file of observed) if (file) {
      if (new Set(file.assertionResults.map(test => test.fullName)).size !== file.assertionResults.length) throw new Error("Duplicate assertion results");
      if ((file.status === "skipped" || file.status === "pending") && file.assertionResults.some(test => test.status === "passed" || test.status === "failed")) throw new Error("Contradictory file and assertion results");
    }
    const passed = assertions.filter(test => test.status === "passed").length, failed = assertions.filter(test => test.status === "failed").length;
    const skipped = assertions.length - passed - failed;
    const missing = item.files.filter((_file, index) => !observed[index]);
    const empty = item.files.filter((_file, index) => observed[index]?.assertionResults.length === 0);
    const status = failed || observed.some(file => file?.status === "failed") ? "failed" : missing.length || empty.length ? "unverified" : passed === 0 ? "skipped" : skipped ? "partial" : "passed";
    return { ...item, status, passed, failed, skipped, missing, empty, cases: assertions.map(test => ({ name: test.fullName, status: test.status, durationMs: test.duration ?? null })) };
  });
  const modules = [...new Set(rows.map(row => row.module))].map(module => {
    const routes = rows.filter(row => row.module === module);
    const status = routes.some(row => row.status === "failed") ? "failed" : routes.some(row => row.status === "unverified") ? "unverified" : routes.every(row => row.status === "skipped") ? "skipped" : routes.some(row => ["partial", "skipped"].includes(row.status)) ? "partial" : "passed";
    return { module, status, routes: routes.map(({ cases: _cases, ...row }) => row) };
  });
  return { format: "core-module-tests-v1", accepted: rows.every(row => !["failed", "unverified"].includes(row.status)) && rows.some(row => row.passed > 0), modules, rows,
    note: "Module/route labels locate the observed failure, not necessarily its root cause. Skipped native PostgreSQL tests are unverified by this command; use the disposable fixture separately." };
}
