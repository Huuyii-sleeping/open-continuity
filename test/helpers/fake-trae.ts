import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export const FAKE_TRAE_THREAD_ID = "thread-fictional-capture";

export function installFakeTraeCli(root: string): string {
  const bin = join(root, "bin");
  mkdirSync(bin, { recursive: true });
  const executable = join(bin, "traecli");
  const script = String.raw`#!${process.execPath}
import readline from "node:readline";

const args = process.argv.slice(2);
const fs = await import("node:fs");
const path = await import("node:path");
const stateDirectory = process.env.TEST_STATE_DIR || path.join(process.env.HOME || "/tmp", "fictional-trae-state");
fs.mkdirSync(stateDirectory, { recursive: true });
const mcpState = path.join(stateDirectory, "open_continuity.mcp");
if (args[0] === "--version") {
  process.stdout.write("traecli 9.9.9-fictional\n");
  process.exit(0);
}
if (args[0] === "mcp" && args[1] === "get") {
  if (!fs.existsSync(mcpState)) process.exit(1);
  process.stdout.write(JSON.stringify({ name: "open_continuity", enabled: true, transport: { type: "stdio" } }) + "\n");
  process.exit(0);
}
if (args[0] === "mcp" && args[1] === "add") { fs.writeFileSync(mcpState, "configured\n"); process.exit(0); }
if (args[0] === "mcp" && args[1] === "remove") { fs.rmSync(mcpState, { force: true }); process.exit(0); }
if (args[0] === "app-server" && args.includes("--help")) {
  process.stdout.write("Usage: traecli app-server --listen <address>\n");
  process.exit(0);
}
if (args[0] !== "app-server") process.exit(2);

const workspace = process.env.TEST_TRAE_WORKSPACE || "/tmp/fictional-capture-workspace";
const thread = {
  id: "thread-fictional-capture",
  sessionId: "session-fictional-capture",
  cwd: workspace,
  cliVersion: "9.9.9-fictional",
  preview: "A fictional preference capture test",
  createdAt: 1_800_000_000,
  updatedAt: 1_800_000_100,
  ephemeral: false,
  turns: [{
    id: "turn-fictional-complete",
    status: "completed",
    startedAt: 1_800_000_000,
    completedAt: 1_800_000_100,
    items: [
      { id: "item-user", type: "userMessage", content: [{ type: "text", text: "我偏好先给结论，再列出验证结果。" }] },
      { id: "item-commentary", type: "agentMessage", phase: "commentary", text: "正在处理虚构测试。" },
      { id: "item-tool", type: "commandExecution", command: "printf fictional", cwd: workspace, aggregatedOutput: "fictional", status: "completed" },
      { id: "item-final", type: "agentMessage", phase: "final_answer", text: "收到，这是虚构测试。" }
    ]
  }]
};
const ephemeral = { ...thread, id: "thread-fictional-side", sessionId: "session-fictional-side", ephemeral: true, turns: [] };
const input = readline.createInterface({ input: process.stdin });
input.on("line", (line) => {
  const request = JSON.parse(line);
  if (typeof request.id !== "number") return;
  let result;
  if (request.method === "initialize") result = { serverInfo: { name: "fake-trae", version: "1" } };
  else if (request.method === "thread/list") {
    const cursor = request.params?.cursor;
    result = request.params?.limit === 1
      ? (cursor ? { data: [ephemeral], nextCursor: null } : { data: [thread], nextCursor: "fictional-page-2" })
      : { data: [thread, ephemeral], nextCursor: null };
  }
  else if (request.method === "thread/read" && request.params?.threadId === thread.id) result = { thread };
  else {
        process.stdout.write(JSON.stringify({ id: request.id, error: { message: "Unknown fictional request" } }) + "\n");
    return;
  }
      process.stdout.write(JSON.stringify({ id: request.id, result }) + "\n");
});
`;
  writeFileSync(executable, script, { mode: 0o755 });
  chmodSync(executable, 0o755);
  const launchctl = join(bin, "launchctl");
  const launchctlScript = String.raw`#!${process.execPath}
import fs from "node:fs";
import path from "node:path";
const args = process.argv.slice(2);
const stateDirectory = process.env.TEST_STATE_DIR || path.join(process.env.HOME || "/tmp", "fictional-trae-state");
fs.mkdirSync(stateDirectory, { recursive: true });
const state = path.join(stateDirectory, "capture.launchd");
if (args[0] === "print") process.exit(fs.existsSync(state) ? 0 : 1);
if (args[0] === "bootstrap") { fs.writeFileSync(state, args.join(" ") + "\n"); process.exit(0); }
if (args[0] === "bootout") { fs.rmSync(state, { force: true }); process.exit(0); }
process.exit(2);
`;
  writeFileSync(launchctl, launchctlScript, { mode: 0o755 });
  chmodSync(launchctl, 0o755);
  return bin;
}
