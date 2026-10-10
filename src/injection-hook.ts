import { createInterface } from "node:readline";
import { runInjectionHook } from "./injection/injection-service.js";

let input = "";
for await (const line of createInterface({ input: process.stdin })) input += line;
try {
  const payload = input.trim() ? JSON.parse(input) : {};
  const output = await runInjectionHook(payload);
  process.stdout.write(JSON.stringify(output) + "\n");
} catch {
  process.stdout.write(JSON.stringify({ continue: true, suppressOutput: true }) + "\n");
}
