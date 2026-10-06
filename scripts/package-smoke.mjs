import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const directory = mkdtempSync(join(tmpdir(), "open-continuity-package-smoke-"));
const packageDirectory = join(directory, "package");
const installDirectory = join(directory, "install");
const npmCommand = process.platform === "win32" ? "npm.cmd" : "npm";

try {
  mkdirSync(packageDirectory);
  const filename = execFileSync(npmCommand, ["pack", "--silent", "--pack-destination", packageDirectory], {
    cwd: process.cwd(),
    encoding: "utf8",
  }).trim().split(/\r?\n/).at(-1);
  if (!filename) throw new Error("npm pack did not return a tarball name");

  const tarball = join(packageDirectory, filename);
  execFileSync(npmCommand, ["install", "--prefix", installDirectory, "--no-audit", "--no-fund", tarball], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "inherit"],
  });

  const cli = join(installDirectory, "node_modules", ".bin", "open-continuity");
  const demo = JSON.parse(execFileSync(cli, ["demo", "--json"], { encoding: "utf8" }));
  if (demo.ok !== true || demo.tools !== 9 || demo.handoff?.status !== "ready") {
    throw new Error("Installed package demo did not satisfy the release smoke contract");
  }
  process.stdout.write(JSON.stringify({
    ok: true,
    package: filename,
    install: "isolated temporary prefix",
    demo: { tools: demo.tools, sharedMemory: demo.sharedMemory?.persistedAcrossAgentRestart, handoff: demo.handoff.status },
    cleanup: "complete",
  }, null, 2) + "\n");
} finally {
  rmSync(directory, { recursive: true, force: true });
}
