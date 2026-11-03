import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { expect, it } from "vitest";
import { createMcpServer } from "../../../src/mcp/server.js";
import { buildHttpApp } from "../../../src/http/app.js";
import { AccessPolicy } from "../../../src/core/policy/access-policy.js";
import { denseActor, denseFixture } from "../../helpers/dense-fixture.js";

it("transports explicitly enabled Dense evidence through existing MCP tools with bound identity", async () => {
  const f = denseFixture(); await f.remember("current approved fact"); await f.remember("unrelated"); await f.service.synchronizeDenseIndex(denseActor);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "fictional-dense-client", version: "0.1.0" });
  const server = createMcpServer(f.service, new AccessPolicy(), undefined, denseActor);
  try {
    await server.connect(serverTransport); await client.connect(clientTransport);
    const read = async (name: string, args: Record<string, unknown>) => {
      const result = await client.callTool({ name, arguments: args }); expect(result.isError).not.toBe(true);
      const blocks = result.content as Array<{ type: string; text?: string }>;
      return JSON.parse(blocks.find(block => block.type === "text")?.text ?? "null") as unknown;
    };
    expect(await read("memory_capabilities", {})).toMatchObject({ retrieval: { semantic: true, experimentalDense: { status: "experimental" } } });
    expect(await read("memory_recall", { query: "fictional semantic question" })).toMatchObject({ memories: [{ retrieval: { channels: ["dense"] } }] });
    expect(await read("memory_context", { query: "fictional semantic question" })).toMatchObject({ items: [{ reasons: expect.arrayContaining(["retrieval_dense"]) }] });
    expect(await read("memory_query", { query: "fictional semantic question" })).toMatchObject({ answer: { citations: [expect.objectContaining({ version: 1 })] } });
  } finally { await client.close(); await server.close(); await f.cleanup(); }
});

it("transports Dense explanations through existing HTTP routes", async () => {
  const f = denseFixture(); await f.remember("current approved fact"); await f.remember("unrelated"); await f.service.synchronizeDenseIndex(denseActor);
  const app = buildHttpApp(f.service); await app.ready();
  try {
    expect((await app.inject({ method: "GET", url: "/v1/capabilities" })).json()).toMatchObject({ retrieval: { semantic: true, experimentalDense: { mode: "miss_only" } } });
    const context = await app.inject({ method: "POST", url: "/v1/context-pack", payload: { ...denseActor, query: "fictional semantic question" } });
    expect(context.statusCode).toBe(200); expect(context.json()).toMatchObject({ items: [{ retrieval: { channels: ["dense"] } }] });
    const query = await app.inject({ method: "POST", url: "/v1/query", payload: { ...denseActor, query: "fictional semantic question" } });
    expect(query.statusCode).toBe(200); expect(query.json()).toMatchObject({ answer: { citations: [expect.objectContaining({ version: 1 })] } });
  } finally { await app.close(); await f.cleanup(); }
});
