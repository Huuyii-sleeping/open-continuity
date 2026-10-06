import { randomUUID } from "node:crypto";
import { existsSync, statSync } from "node:fs";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import type { AgentName, LocalConfig } from "./config.js";
import { connectorStatus } from "./connectors.js";
import { OPEN_CONTINUITY_VERSION } from "../version.js";

export type CheckStatus = "pass" | "warn" | "fail";
export interface DoctorCheck { name: string; status: CheckStatus; detail: string; }

export async function runDoctor(config: LocalConfig, serverPath: string, env: NodeJS.ProcessEnv = process.env): Promise<{ ok: boolean; checks: DoctorCheck[] }> {
  const checks: DoctorCheck[] = [];
  checks.push({ name: "Node.js", status: Number(process.versions.node.split(".")[0]) >= 22 ? "pass" : "fail", detail: process.version });
  const databaseExists = existsSync(config.databasePath);
  checks.push({ name: "Database", status: databaseExists ? "pass" : "warn", detail: databaseExists ? `${config.databasePath} (${statSync(config.databasePath).size} bytes)` : `${config.databasePath} will be created on first use` });
  for (const agent of ["trae", "claude", "codex"] as AgentName[]) {
    const status = connectorStatus(agent, config, env);
    checks.push({ name: `${agent} connector`, status: status.configured ? "pass" : "warn", detail: status.configured ? "configured" : status.detail || "not configured" });
  }
  const transport = new StdioClientTransport({
    command: process.execPath, args: [serverPath, "--mcp"], stderr: "pipe", env: {
      ...Object.fromEntries(Object.entries(env).filter((entry): entry is [string, string] => entry[1] !== undefined)),
      OPEN_CONTINUITY_PROFILE: "lite", OPEN_CONTINUITY_STORE: "sqlite", OPEN_CONTINUITY_SQLITE_PATH: config.databasePath,
      OPEN_CONTINUITY_USER_ID: config.userId, OPEN_CONTINUITY_AGENT_ID: "doctor", OPEN_CONTINUITY_ALLOW_PRIVATE: "false",
    },
  });
  const client = new Client({ name: "open-continuity-doctor", version: OPEN_CONTINUITY_VERSION });
  try {
    await client.connect(transport);
    const tools = await client.listTools();
    const expected = ["memory_capabilities", "memory_remember", "memory_recall", "memory_context", "memory_query", "memory_history", "memory_forget", "memory_handoff_create", "memory_handoff_resume"];
    const names = new Set(tools.tools.map((tool) => tool.name));
    const missing = expected.filter((name) => !names.has(name));
    checks.push({ name: "MCP startup", status: "pass", detail: "server connected" });
    checks.push({ name: "Tool discovery", status: missing.length ? "fail" : "pass", detail: missing.length ? `missing: ${missing.join(", ")}` : `${expected.length} tools available` });
    const capabilities = await client.callTool({ name: "memory_capabilities", arguments: {} });
    checks.push({ name: "Capability probe", status: capabilities.isError ? "fail" : "pass", detail: capabilities.isError ? "tool returned an error" : "passed without writing user data" });
    const recall = await client.callTool({ name: "memory_recall", arguments: { query: `open-continuity-doctor-${randomUUID()}`, limit: 1 } });
    checks.push({ name: "Database read probe", status: recall.isError ? "fail" : "pass", detail: recall.isError ? "read tool returned an error" : "passed without writing user data" });
  } catch (error) {
    checks.push({ name: "MCP startup", status: "fail", detail: error instanceof Error ? error.message : String(error) });
  } finally {
    await client.close().catch(() => undefined);
  }
  return { ok: checks.every((check) => check.status !== "fail"), checks };
}
