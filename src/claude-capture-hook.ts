import { createInterface } from "node:readline";
import { runClaudeCaptureHook } from "./capture/claude-capture-service.js";

let input = "";
for await (const line of createInterface({ input: process.stdin })) input += line;
try {
  const payload = input.trim() ? JSON.parse(input) : {};
  await runClaudeCaptureHook(payload);
} catch {
  // Capture is observability, not a policy gate. Claude must always be allowed
  // to finish even when the local Inbox or transcript is temporarily broken.
}
