import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export function installFakeCodexCli(root: string): string {
  const bin = join(root, "bin");
  mkdirSync(bin, { recursive: true });
  const script = join(bin, "codex");
  writeFileSync(script, `#!/usr/bin/env node
import { existsSync, unlinkSync, writeFileSync } from "node:fs";
import { createInterface } from "node:readline";
const args = process.argv.slice(2);
const state = process.env.FICTIONAL_CODEX_STATE;
const workspace = process.env.FICTIONAL_CODEX_WORKSPACE;
const threadId = "fictional-codex-session";
if (args[0] === "--version") { process.stdout.write("0.0.0-fictional\\n"); process.exit(0); }
if (args[0] === "app-server" && args.includes("--help")) { process.stdout.write("fictional app-server\\n"); process.exit(0); }
if (args[0] === "mcp" && state) {
  if (args[1] === "get") process.exit(existsSync(state) ? 0 : 1);
  if (args[1] === "add") { writeFileSync(state, "configured\\n"); process.exit(0); }
  if (args[1] === "remove") { if (existsSync(state)) unlinkSync(state); process.exit(0); }
  process.exit(2);
}
if (args[0] !== "app-server" || !args.includes("--stdio")) process.exit(2);
const turns = [{
  id: "fictional-codex-turn", status: "completed", startedAt: 1893456000, completedAt: 1893456030,
  items: [
    { type: "userMessage", id: "fictional-codex-user", content: [{ type: "text", text: "请记住：使用虚构的蓝色纸飞机。", text_elements: [] }] },
    { type: "reasoning", id: "fictional-codex-reasoning", summary: ["private reasoning must not be captured"], content: ["private reasoning must not be captured"] },
    { type: "agentMessage", id: "fictional-codex-assistant", text: "收到，已进入待审核候选。", phase: "final_answer" },
    { type: "commandExecution", id: "fictional-codex-command", command: "printf fictional", cwd: workspace, aggregatedOutput: "fictional command output", status: "completed" },
    { type: "mcpToolCall", id: "fictional-codex-mcp", server: "fictional", tool: "lookup", arguments: { query: "fictional" }, result: { value: "fictional result" }, status: "completed" },
    { type: "contextCompaction", id: "fictional-codex-compaction" },
  ],
}];
function respond(message) {
  if (message.method === "initialize") return { id: message.id, result: { userAgent: "Codex/0.0.0-fictional", codexHome: process.env.CODEX_HOME || "/fictional-codex-home", platformFamily: "unix", platformOs: "fictional" } };
  if (message.method === "thread/list") return { id: message.id, result: { data: [{ id: threadId, sessionId: threadId, cwd: workspace, cliVersion: "0.0.0-fictional", preview: "虚构 Codex 会话", createdAt: 1893456000, updatedAt: 1893456030, ephemeral: false }], nextCursor: null } };
  if (message.method === "thread/read") return { id: message.id, result: { thread: { id: threadId, sessionId: threadId, cwd: workspace, cliVersion: "0.0.0-fictional", preview: "虚构 Codex 会话", createdAt: 1893456000, updatedAt: 1893456030, ephemeral: false, turns: [] } } };
  if (message.method === "thread/turns/list") return { id: message.id, result: turns };
  return { id: message.id, result: {} };
}
for await (const line of createInterface({ input: process.stdin })) {
  if (!line.trim()) continue;
  const message = JSON.parse(line);
  if (message.method === "initialized") continue;
  process.stdout.write(JSON.stringify(respond(message)) + "\\n");
}
`, { encoding: "utf8", mode: 0o700 });
  chmodSync(script, 0o700);
  return bin;
}
