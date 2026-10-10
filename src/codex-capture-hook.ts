import { createInterface } from "node:readline";
import { runCodexCaptureHook } from "./capture/codex-capture-service.js";

let input = "";
for await (const line of createInterface({ input: process.stdin })) input += line;
try {
  const payload = input.trim() ? JSON.parse(input) : {};
  await runCodexCaptureHook(payload);
} catch {
  // Capture is observability, not a policy gate. Codex must be allowed to
  // finish even if the local Inbox or app-server is temporarily unavailable.
}
