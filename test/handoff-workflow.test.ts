import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { expect, it } from "vitest";
import { z } from "zod";
import { buildHttpApp } from "../src/http/app.js";
import { AccessPolicy } from "../src/core/policy/access-policy.js";
import { handoffDraftSchema } from "../src/core/memory/handoff/review.js";

function data(result: unknown) {
  const value = z.object({ isError: z.boolean().optional(), content: z.array(z.object({ type: z.string(), text: z.string().optional() })) }).parse(result);
  expect(value.isError).not.toBe(true);
  const blocks = value.content;
  return JSON.parse(blocks.find(block => block.type === "text")?.text ?? "{}");
}
it("preserves HTTP authorization and requires the reviewed draft before another Agent can resume", async () => {
  const app = buildHttpApp(undefined, new AccessPolicy({ apiKey: "fictional-key" })); await app.ready();
  const actor = { userId: "fictional-http-handoff", agentId: "fictional-source" }, content = { ...actor, taskId: "fictional-http-export", summary: "Fictional JSON export complete; CSV pending", sensitivity: "public", nextActions: ["Implement CSV"] };
  try {
    expect((await app.inject({ method: "POST", url: "/v1/handoffs/prepare", payload: content })).statusCode).toBe(401);
    const headers = { "x-open-continuity-api-key": "fictional-key" };
    const prepared = await app.inject({ method: "POST", url: "/v1/handoffs/prepare", headers, payload: content }); expect(prepared.statusCode).toBe(200);
    const draft = handoffDraftSchema.parse(prepared.json().draft);
    expect((await app.inject({ method: "GET", url: `/v1/handoffs/${content.taskId}?userId=${actor.userId}&agentId=fictional-reader`, headers })).json()).toMatchObject({ status: "not_found" });
    const confirm = { ...actor, draft, reviewedFingerprint: draft.fingerprint, userConfirmed: true };
    expect((await app.inject({ method: "POST", url: "/v1/handoffs/confirm", payload: confirm })).statusCode).toBe(401);
    expect((await app.inject({ method: "POST", url: "/v1/handoffs/confirm", headers, payload: { ...confirm, userConfirmed: false } })).statusCode).toBe(400);
    expect((await app.inject({ method: "POST", url: "/v1/handoffs/confirm", headers, payload: confirm })).statusCode).toBe(200);
    const resumed = await app.inject({ method: "GET", url: `/v1/handoffs/${content.taskId}?userId=${actor.userId}&agentId=fictional-reader`, headers });
    expect(resumed.json()).toMatchObject({ status: "ready", capsule: { nextActions: ["Implement CSV"], sourceAgentId: actor.agentId } });
  } finally { await app.close(); }
});
it("runs prepare in MCP process A, user confirmation in CLI, and resume in a fresh MCP process B", async () => {
  const root = mkdtempSync(join(tmpdir(), "oc-fictional-handoff-workflow-"));
  const cli = join(process.cwd(), "dist/src/cli.js"), server = join(process.cwd(), "dist/src/server.js");
  const env = { ...process.env, HOME: join(root, "home"), CODEX_HOME: join(root, "codex"), OPEN_CONTINUITY_HOME: join(root, "state") };
  const config = JSON.parse(execFileSync(process.execPath, [cli, "init", "--json"], { env, cwd: root, encoding: "utf8" })).config;
  const clients: Client[] = [];
  async function connect(agent: string) {
    const client = new Client({ name: "fictional-protocol-caller", version: "1.0" }); clients.push(client);
    const childEnv = Object.fromEntries(Object.entries({ ...env, OPEN_CONTINUITY_PROFILE: "lite", OPEN_CONTINUITY_STORE: "sqlite",
      OPEN_CONTINUITY_SQLITE_PATH: config.databasePath, OPEN_CONTINUITY_USER_ID: config.userId, OPEN_CONTINUITY_AGENT_ID: agent, OPEN_CONTINUITY_ALLOW_PRIVATE: "false" })
      .filter((entry): entry is [string, string] => entry[1] !== undefined));
    await client.connect(new StdioClientTransport({ command: process.execPath, args: [server, "--mcp"], env: childEnv, stderr: "pipe" })); return client;
  }
  try {
    const writer = await connect("codex");
    const prepared = data(await writer.callTool({ name: "memory_handoff_prepare", arguments: { taskId: "fictional-export", summary: "Fictional JSON exporter complete; CSV pending", sensitivity: "public",
      decisions: ["Remain offline"], blockedBy: ["Timezone undecided"], artifacts: ["fictional/schema.json"], nextActions: ["Confirm timezone, then implement CSV"], userId: "spoofed-user", agentId: "spoofed-agent" } }));
    const draft = handoffDraftSchema.parse(prepared.draft); expect(draft.input).toMatchObject({ userId: config.userId, agentId: "codex" });
    expect(data(await writer.callTool({ name: "memory_handoff_resume", arguments: { taskId: "fictional-export" } }))).toMatchObject({ status: "not_found" });
    expect((await writer.callTool({ name: "memory_handoff_prepare", arguments: { taskId: "fictional-export", summary: "Fictional private access", includePrivate: true } })).isError).toBe(true);
    await writer.close(); const path = join(root, "fictional-reviewed.json"); writeFileSync(path, JSON.stringify(prepared));
    execFileSync(process.execPath, [cli, "handoff", "confirm", path, "--agent", "codex", "--yes", "--reviewed", draft.fingerprint, "--json"], { env, cwd: root });
    const reader = await connect("claude");
    const refused = await reader.callTool({ name: "memory_handoff_confirm", arguments: { draft, reviewedFingerprint: draft.fingerprint, userConfirmed: true } });
    expect(refused.isError).toBe(true);
    const resumed = data(await reader.callTool({ name: "memory_handoff_resume", arguments: { taskId: "fictional-export" } }));
    expect(resumed).toMatchObject({ status: "ready", capsule: { sourceAgentId: "codex", decisions: ["Remain offline"], blockedBy: ["Timezone undecided"], nextActions: ["Confirm timezone, then implement CSV"] } });
    expect(data(await reader.callTool({ name: "memory_handoff_resume", arguments: { taskId: "different-fictional-task" } }))).toMatchObject({ status: "not_found" });
  } finally { for (const client of clients) await client.close(); rmSync(root, { recursive: true, force: true }); }
}, 15000);
