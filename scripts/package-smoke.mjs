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

  const modularCore = JSON.parse(execFileSync(process.execPath, ["--input-type=module", "-e", `
import { existsSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
const root = process.argv[1], database = process.argv[2];
const load = name => import(pathToFileURL(join(root, "dist/src", name)).href);
for (const name of ["src/core/README.md", "docs/retrieval-core/phase-7a-modular-kernel.md", "docs/retrieval-core/phase-7a-validation.md"]) {
  if (!existsSync(join(root, name))) throw new Error("Missing modular kernel documentation");
}
const { MemoryService } = await load("core/application/memory-service.js");
const { SqliteMemoryStore } = await load("storage/sqlite/sqlite-memory-store.js");
if ((await load("core/memory-service.js")).MemoryService !== MemoryService
  || (await load("sqlite/sqlite-memory-store.js")).SqliteMemoryStore !== SqliteMemoryStore) throw new Error("Compatibility constructors differ");
for (const name of ["migrate-sqlite.js", "migrate-postgres.js", "data.js"]) {
  if (!existsSync(join(root, "dist/src/cli/storage", name))) throw new Error("Missing storage command");
}
const store = new SqliteMemoryStore(database), service = new MemoryService(store);
const actor = { userId: "fictional-package-user", agentId: "fictional-reader" };
try {
  await service.remember({ ...actor, key: "focused", value: "needle needle needle", kind: "decision", userConfirmed: true, idempotencyKey: "fictional-focused" });
  await service.remember({ ...actor, key: "diluted", value: "needle " + "filler ".repeat(100), kind: "decision", userConfirmed: true, idempotencyKey: "fictional-diluted" });
  const result = await service.recall({ ...actor, query: "needle" });
  if (result.memories[0]?.key !== "focused" || result.memories[0]?.retrieval?.evidence?.[0]?.score.model !== "fts5_bm25") throw new Error("Installed BM25 contract failed");
  const reader = store.candidateReaders.full_text;
  if ((await reader({ ...actor, query: "needle" })).hits.length !== 2) throw new Error("Installed Reader failed");
  process.stdout.write(JSON.stringify({ legacyIdentity: true, independentReader: true, bm25: true, storageCommands: true, documentation: true }));
} finally { await service.close(); }
`, join(installDirectory, "node_modules/open-continuity"), join(directory, "fictional-module.db")], { encoding: "utf8" }));

  const cli = join(installDirectory, "node_modules", ".bin", "open-continuity");
  const demo = JSON.parse(execFileSync(cli, ["demo", "--json"], { encoding: "utf8" }));
  if (demo.ok !== true || demo.tools !== 11 || demo.handoff?.status !== "ready") {
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
  const taskInput = join(directory, "fictional-task.json"), draftPath = join(directory, "fictional-handoff.json");
  writeFileSync(taskInput, JSON.stringify({ taskId: "fictional-package-handoff", summary: "Fictional JSON export is complete; CSV remains", decisions: ["Remain offline"], nextActions: ["Confirm timezone, then implement CSV"], blockedBy: ["Timezone undecided"] }));
  const prepared = JSON.parse(execFileSync(cli, ["handoff", "prepare", "--input", taskInput, "--output", draftPath, "--agent", "codex", "--share", "--json"], { env, encoding: "utf8" }));
  const waiting = JSON.parse(execFileSync(cli, ["handoff", "resume", "fictional-package-handoff", "--agent", "claude", "--json"], { env, encoding: "utf8" }));
  if (waiting.status !== "not_found") throw new Error("Unconfirmed package draft became visible");
  execFileSync(cli, ["handoff", "confirm", draftPath, "--agent", "codex", "--yes", "--reviewed", prepared.draft.fingerprint, "--json"], { env, encoding: "utf8" });
  const handed = JSON.parse(execFileSync(cli, ["handoff", "resume", "fictional-package-handoff", "--agent", "claude", "--json"], { env, encoding: "utf8" }));
  if (handed.status !== "ready" || handed.capsule.sourceAgentId !== "codex" || handed.capsule.blockedBy[0] !== "Timezone undecided") throw new Error("Installed reviewed handoff failed");
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
    modularCore,
    demo: { tools: demo.tools, sharedMemory: demo.sharedMemory?.persistedAcrossAgentRestart, handoff: demo.handoff.status },
    reviewedHandoff: { preparedWithoutWrite: true, userConfirmed: true, resumedAcrossAgents: true },
    claudeAdapter: { setup: claude.ok, doctor: claude.doctor.ok, capture: claude.steps.capture.enabled, injection: claude.steps.injection.enabled },
    governance: { conversationRetentionDays: governance.policies.conversationRetentionDays, longTermMemoryPreserved: governance.longTermMemory.preservedByTransientCleanup },
    cleanup: "complete",
  }, null, 2) + "\n");
} finally {
  rmSync(directory, { recursive: true, force: true });
}
