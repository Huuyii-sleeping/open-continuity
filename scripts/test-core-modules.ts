import { spawn } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { coreTestCatalog, selectModuleTests } from "./core-test-catalog.js";
import { summarizeModuleTests } from "./core-test-report.js";
import { moduleTestProvenance } from "./core-test-provenance.js";
import { isDeepStrictEqual } from "node:util";
import { registeredCoreContracts } from "./core-contract-map.js";
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
let temporary: string | undefined;
try {
  const { values } = parseArgs({ options: { module: { type: "string" }, route: { type: "string" }, list: { type: "boolean" }, "report-dir": { type: "string" } }, strict: true });
  const selected = selectModuleTests(coreTestCatalog(root), values.module, values.route);
  if (values.list) process.stdout.write(selected.map(row => row.module + "/" + row.route + " -> " + row.files.join(", ")).join("\n") + "\n");
  else {
    let directory: string;
    if (values["report-dir"] !== undefined) {
      if (!values["report-dir"].trim()) throw new Error("Report directory must be nonempty");
      directory = resolve(values["report-dir"]);
      if (directory === root || directory.startsWith(root + "/")) throw new Error("Generated test evidence must stay outside the repository");
      mkdirSync(directory, { mode: 0o700 });
    } else { temporary = mkdtempSync(join(tmpdir(), "oc-fictional-module-tests-")); directory = temporary; }
    const rawPath = join(directory, "vitest.json");
    const provenance = moduleTestProvenance(root);
    const env = { ...process.env }; delete env.OPEN_CONTINUITY_TEST_POSTGRES_URL;
    const code = await new Promise<number>((done, reject) => {
      const child = spawn(process.execPath, [join(root, "node_modules/vitest/vitest.mjs"), "run", ...selected.flatMap(row => row.files), "--reporter=json", "--outputFile=" + rawPath], { cwd: root, env, stdio: ["ignore", "pipe", "pipe"] });
      // Test payloads are intentionally not copied into the console; raw fictional evidence is in the requested directory.
      child.stdout.resume(); child.stderr.resume(); child.once("error", reject); child.once("exit", code => done(code ?? 1));
    });
    if (!isDeepStrictEqual(provenance, moduleTestProvenance(root))) throw new Error("Source, fixtures or harness changed during module testing");
    const contracts = registeredCoreContracts.filter(contract => selected.some(route => route.files.includes(contract.test)));
    const report = { ...summarizeModuleTests(root, selected, JSON.parse(readFileSync(rawPath, "utf8"))), provenance, registeredContracts: contracts };
    writeFileSync(join(directory, "summary.json"), JSON.stringify(report, null, 2) + "\n", { mode: 0o600 });
    for (const row of report.rows) {
      const routeDirectory = join(directory, row.module); mkdirSync(routeDirectory, { recursive: true, mode: 0o700 });
      writeFileSync(join(routeDirectory, row.route + ".json"), JSON.stringify(row, null, 2) + "\n", { mode: 0o600 });
      process.stdout.write(`${row.module}/${row.route}: ${row.status} (${row.passed} passed, ${row.failed} failed, ${row.skipped} skipped)\n`);
      for (const test of row.cases.filter(test => test.status === "failed")) process.stdout.write(`  failed: ${test.name}\n`);
    }
    writeFileSync(join(directory, "README.md"), "# 内核分模块测试\n\n每条线路独立报告；partial/skipped不能当作完整通过，空结果/missing直接拒绝。失败位置是观测位置，不等于自动定位根因。\n\n" + report.rows.map(row => `- [${row.module}/${row.route}：${row.status}](./${row.module}/${row.route}.json)`).join("\n") + "\n", { mode: 0o600 });
    if (code !== 0 || !report.accepted) process.exitCode = 1;
  }
} catch { process.stderr.write("Module tests failed or their result grid is incomplete; inspect the explicit fictional report directory.\n"); process.exitCode = 1; }
finally { if (temporary) rmSync(temporary, { recursive: true, force: true }); }
