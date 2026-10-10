import { execFileSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";

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

  const home = join(directory, "home");
  const data = join(directory, "data");
  const workspace = join(directory, "fictional-workspace");
  const fakeBin = join(directory, "bin");
  const fakeClaudeState = join(directory, "fictional-claude-mcp-state");
  mkdirSync(home, { recursive: true });
  mkdirSync(workspace, { recursive: true });
  mkdirSync(fakeBin, { recursive: true });
  const fakeClaude = join(fakeBin, "claude");
  writeFileSync(fakeClaude, `#!/usr/bin/env node
import { existsSync, unlinkSync, writeFileSync } from "node:fs";
const args = process.argv.slice(2);
const state = process.env.FICTIONAL_CLAUDE_STATE;
if (args[0] === "--version") { process.stdout.write("9.9.9-fictional\\n"); process.exit(0); }
if (args[0] !== "mcp" || !state) process.exit(2);
if (args[1] === "get") process.exit(existsSync(state) ? 0 : 1);
if (args[1] === "add") { writeFileSync(state, "configured\\n"); process.exit(0); }
if (args[1] === "remove") { if (existsSync(state)) unlinkSync(state); process.exit(0); }
process.exit(2);
`, { encoding: "utf8", mode: 0o700 });
  chmodSync(fakeClaude, 0o700);
  const env = {
    ...process.env,
    HOME: home,
    OPEN_CONTINUITY_HOME: data,
    CLAUDE_CONFIG_DIR: join(home, ".claude"),
    FICTIONAL_CLAUDE_STATE: fakeClaudeState,
    PATH: `${fakeBin}${delimiter}${process.env.PATH || ""}`,
  };
  execFileSync(cli, ["init", "--json"], { env, encoding: "utf8" });
  const claude = JSON.parse(execFileSync(cli, ["setup", "claude", "--workspace", workspace, "--json"], { env, encoding: "utf8" }));
  if (claude.ok !== true || claude.doctor?.ok !== true || claude.steps?.capture?.enabled !== true || claude.steps?.injection?.enabled !== true) {
    throw new Error("Installed package Claude Adapter setup did not satisfy the release smoke contract");
  }
  const governance = JSON.parse(execFileSync(cli, ["data", "status", "--json"], { env, encoding: "utf8" }));
  if (governance.ok !== true || governance.policies?.conversationRetentionDays !== 7 || governance.longTermMemory?.preservedByTransientCleanup !== true) {
    throw new Error("Installed package data-governance status did not satisfy the release smoke contract");
  }
  process.stdout.write(JSON.stringify({
    ok: true,
    package: filename,
    install: "isolated temporary prefix",
    demo: { tools: demo.tools, sharedMemory: demo.sharedMemory?.persistedAcrossAgentRestart, handoff: demo.handoff.status },
    claudeAdapter: { setup: claude.ok, doctor: claude.doctor.ok, capture: claude.steps.capture.enabled, injection: claude.steps.injection.enabled },
    governance: { conversationRetentionDays: governance.policies.conversationRetentionDays, longTermMemoryPreserved: governance.longTermMemory.preservedByTransientCleanup },
    cleanup: "complete",
  }, null, 2) + "\n");
} finally {
  rmSync(directory, { recursive: true, force: true });
}
