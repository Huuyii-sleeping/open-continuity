import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function setup() {
  const root = mkdtempSync(join(tmpdir(), "oc-fictional-handoff-cli-")); roots.push(root);
  const env = { ...process.env, HOME: join(root, "home"), CODEX_HOME: join(root, "codex"), CLAUDE_CONFIG_DIR: join(root, "claude"), OPEN_CONTINUITY_HOME: join(root, "state") };
  const cli = join(process.cwd(), "dist/src/cli.js");
  const run = (...args: string[]) => execFileSync(process.execPath, [cli, ...args, "--json"], { env, cwd: root, encoding: "utf8" });
  const reject = (...args: string[]) => spawnSync(process.execPath, [cli, ...args, "--json"], { env, cwd: root, encoding: "utf8" });
  run("init"); const input = join(root, "fictional-task.json"), draft = join(root, "fictional-draft.json");
  writeFileSync(input, JSON.stringify({ taskId: "fictional-export", summary: "Fictional JSON export complete; CSV pending", decisions: ["Remain offline"], nextActions: ["Confirm timezone, then add CSV"], blockedBy: ["Timezone undecided"] }));
  return { root, input, draft, run, reject };
}
it("uses normal CLI prepare/review/confirm/resume with explicit approval and persistent cross-agent state", () => {
  const rt = setup(), first = JSON.parse(rt.run("handoff", "prepare", "--input", rt.input, "--output", rt.draft, "--agent", "codex", "--share"));
  expect(first).toMatchObject({ status: "awaiting_user_confirmation", draft: { input: { sensitivity: "public", agentId: "codex" } } });
  if (process.platform !== "win32") expect(statSync(rt.draft).mode & 0o777).toBe(0o600);
  expect(JSON.parse(rt.run("handoff", "resume", "fictional-export", "--agent", "claude"))).toMatchObject({ status: "not_found", capsule: null });
  expect(rt.reject("handoff", "confirm", rt.draft, "--agent", "codex").status).toBe(1);
  expect(JSON.parse(rt.run("handoff", "review", rt.draft)).text).toContain("尚未写入");
  const confirmed = JSON.parse(rt.run("handoff", "confirm", rt.draft, "--agent", "codex", "--yes", "--reviewed", first.draft.fingerprint));
  expect(confirmed).toMatchObject({ memory: { current: { scope: "task", version: 1, userConfirmed: true } } });
  const resumed = JSON.parse(rt.run("handoff", "resume", "fictional-export", "--agent", "claude"));
  expect(resumed).toMatchObject({ status: "ready", capsule: { nextActions: ["Confirm timezone, then add CSV"], blockedBy: ["Timezone undecided"] } });
  expect(resumed.text).toContain("sourceEventId");
  const again = JSON.parse(rt.run("handoff", "confirm", rt.draft, "--agent", "codex", "--yes", "--reviewed", first.draft.fingerprint));
  expect(again.memory.duplicate).toBe(true);
}, 15000);
it("rejects changed drafts, cross-actor confirmation, silent visibility changes and output overwrite", () => {
  const rt = setup(), first = JSON.parse(rt.run("handoff", "prepare", "--input", rt.input, "--output", rt.draft, "--agent", "codex"));
  expect(rt.reject("handoff", "prepare", "--input", rt.input, "--output", rt.draft, "--agent", "codex").status).toBe(1);
  expect(rt.reject("handoff", "confirm", rt.draft, "--agent", "claude", "--yes", "--reviewed", first.draft.fingerprint).status).toBe(1);
  expect(rt.reject("handoff", "confirm", rt.draft, "--agent", "codex", "--yes", "--reviewed", first.draft.fingerprint, "--share").status).toBe(1);
  const value = JSON.parse(readFileSync(rt.draft, "utf8")); value.input.summary = "Changed fictional task"; writeFileSync(rt.draft, JSON.stringify(value));
  expect(rt.reject("handoff", "confirm", rt.draft, "--agent", "codex", "--yes", "--reviewed", first.draft.fingerprint).status).toBe(1);
  expect(JSON.parse(rt.run("handoff", "resume", "fictional-export", "--agent", "claude"))).toMatchObject({ status: "not_found" });
  writeFileSync(rt.input, '"' + "x".repeat(256 * 1024) + '"');
  expect(rt.reject("handoff", "prepare", "--input", rt.input, "--agent", "codex").status).toBe(1);
  writeFileSync(rt.input, Buffer.from([0xff, 0xfe]));
  expect(rt.reject("handoff", "prepare", "--input", rt.input, "--agent", "codex").status).toBe(1);
}, 15000);
