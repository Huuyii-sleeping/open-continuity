import { accessPolicyFromEnv } from "./core/access-policy.js";
import { MemoryService } from "./core/memory-service.js";
import { createStoreFromEnv } from "./core/store-factory.js";
import { buildHttpApp } from "./http/app.js";
import { startMcpStdio } from "./mcp/server.js";

const runtime = await createStoreFromEnv();
const service = new MemoryService(runtime.store, runtime.profile.retrieval, runtime.profile.contextPack, runtime.profile.agenticQuery);
const policy = accessPolicyFromEnv();

if (process.argv.includes("--mcp")) {
  process.stdin.once("end", () => { void service.close(); });
  await startMcpStdio(service, policy, runtime.capabilities, {
    userId: process.env.OPEN_CONTINUITY_USER_ID || undefined,
    agentId: process.env.OPEN_CONTINUITY_AGENT_ID || undefined,
  });
} else {
  const host = process.env.HOST ?? "127.0.0.1";
  const port = Number(process.env.PORT ?? 8787);
  const app = buildHttpApp(service, policy, runtime.capabilities);
  const shutdown = async () => { await app.close(); };
  process.once("SIGINT", () => { void shutdown(); });
  process.once("SIGTERM", () => { void shutdown(); });
  await app.listen({ host, port });
  console.error("OpenContinuity HTTP listening on http://" + host + ":" + port + " using " + runtime.profile.name + "/" + runtime.kind);
}
