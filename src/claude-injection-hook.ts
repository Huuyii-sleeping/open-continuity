import { createInterface } from "node:readline";
import { runInjectionHook } from "./injection/injection-service.js";
import { ClaudeInjectionAdapter } from "./injection/claude-hook-config.js";

const adapter = new ClaudeInjectionAdapter(process.env);
let input = "";
for await (const line of createInterface({ input: process.stdin })) input += line;
try {
  const payload = input.trim() ? JSON.parse(input) : {};
  const output = await runInjectionHook(payload, process.env, { adapter });
  process.stdout.write(JSON.stringify(output) + "\n");
} catch {
  process.stdout.write(JSON.stringify(adapter.emptyOutput()) + "\n");
}
