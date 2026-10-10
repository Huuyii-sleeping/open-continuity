import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export function installFakeClaudeCli(root: string): string {
  const bin = join(root, "bin");
  mkdirSync(bin, { recursive: true });
  const executable = join(bin, "claude");
  const script = String.raw`#!${process.execPath}
import fs from "node:fs";
import path from "node:path";

const args = process.argv.slice(2);
const stateDirectory = process.env.TEST_STATE_DIR || path.join(process.env.HOME || "/tmp", "fictional-claude-state");
fs.mkdirSync(stateDirectory, { recursive: true });
const mcpState = path.join(stateDirectory, "open_continuity.mcp");
if (args[0] === "--version") {
  process.stdout.write("claude-code 9.9.9-fictional\n");
  process.exit(0);
}
if (args[0] === "mcp" && args[1] === "get") {
  if (!fs.existsSync(mcpState)) process.exit(1);
  process.stdout.write(JSON.stringify({ name: "open_continuity", scope: "user", transport: "stdio" }) + "\n");
  process.exit(0);
}
if (args[0] === "mcp" && args[1] === "add") {
  fs.writeFileSync(mcpState, JSON.stringify(args) + "\n");
  const configPath = path.join(process.env.HOME || "/tmp", ".claude.json");
  fs.mkdirSync(path.dirname(configPath), { recursive: true });
  fs.writeFileSync(configPath, JSON.stringify({ mcpServers: { open_continuity: { type: "stdio" } } }, null, 2) + "\n");
  process.exit(0);
}
if (args[0] === "mcp" && args[1] === "remove") {
  fs.rmSync(mcpState, { force: true });
  process.exit(0);
}
process.stderr.write("Unknown fictional Claude command\n");
process.exit(2);
`;
  writeFileSync(executable, script, { mode: 0o755 });
  chmodSync(executable, 0o755);
  return bin;
}
