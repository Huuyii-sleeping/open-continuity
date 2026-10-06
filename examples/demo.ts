import { MemoryService } from "../src/core/memory-service.js";
const memory = new MemoryService();
await memory.remember({ userId: "demo-user", agentId: "codex", key: "response_style", value: "concise", kind: "user_preference", userConfirmed: true, idempotencyKey: "demo-codex-1" });
process.stdout.write(`Claude reads: ${JSON.stringify((await memory.recall({ userId: "demo-user", agentId: "claude" })).memories)}\n`);
await memory.remember({ userId: "demo-user", agentId: "claude", key: "response_style", value: "detailed", kind: "user_preference", userConfirmed: true, idempotencyKey: "demo-claude-1" });
process.stdout.write(`Codex reads latest: ${JSON.stringify((await memory.recall({ userId: "demo-user", agentId: "codex" })).memories)}\n`);
