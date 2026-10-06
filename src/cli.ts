import { basename, dirname, extname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { agentNameSchema, ensureConfig, requireConfig, saveConfig } from "./cli/config.js";
import { connectAgent, detectAgents, disconnectAgent } from "./cli/connectors.js";
import { runDemo } from "./cli/demo.js";
import { runDoctor } from "./cli/doctor.js";
import { exportMemoryPackage, importMemoryPackage } from "./package/memory-package.js";
import { SqliteMemoryStore } from "./sqlite/sqlite-memory-store.js";
import { backupSqliteDatabase, inspectSqliteDatabase, restoreSqliteDatabase } from "./sqlite/maintenance.js";
import { errorResponse, OpenContinuityError } from "./shared/errors.js";
import { OPEN_CONTINUITY_VERSION } from "./version.js";

const args = process.argv.slice(2);
const jsonOutput = args.includes("--json");
const commandArgs = args.filter((arg) => arg !== "--json");
const command = commandArgs[0];
const subcommand = commandArgs[1];
const option = (name: string): string | undefined => {
  const index = args.indexOf(`--${name}`);
  return index >= 0 ? args[index + 1] : args.find((arg) => arg.startsWith(`--${name}=`))?.slice(name.length + 3);
};
const flag = (name: string): boolean => args.includes(`--${name}`);
const output = (value: unknown): void => {
  const rendered = jsonOutput ? JSON.stringify(value) : typeof value === "string" ? value : JSON.stringify(value, null, 2);
  process.stdout.write(`${rendered}\n`);
};
const serverPath = fileURLToPath(new URL("./server.js", import.meta.url));

function help(): string {
  return `OpenContinuity ${OPEN_CONTINUITY_VERSION}

Usage:
  open-continuity init
  open-continuity demo
  open-continuity connect <trae|claude|codex> [--force]
  open-continuity disconnect <trae|claude|codex>
  open-continuity doctor
  open-continuity database check
  open-continuity database backup --output <file>
  open-continuity database restore <backup-file> [--output <file>] --yes
  open-continuity memories list [--query text] [--kind kind] [--limit n]
  open-continuity memories show <memory-id>
  open-continuity memories history <memory-id>
  open-continuity memories forget <memory-id> --yes
  open-continuity export --output <directory>
  open-continuity import <directory>

Global option: --json`;
}

async function main(): Promise<void> {
  if (!command || command === "help" || flag("help")) { output(help()); return; }
  if (command === "init") {
    const result = ensureConfig();
    new SqliteMemoryStore(result.config.databasePath).close();
    output({
      ok: true, created: result.created,
      config: { databasePath: result.config.databasePath, userId: result.config.userId },
      detectedAgents: detectAgents(),
      next: "Run `open-continuity connect <agent>` for each detected agent, then `open-continuity doctor`.",
    });
    return;
  }
  if (command === "demo") {
    output(await runDemo(serverPath));
    return;
  }

  const config = requireConfig();
  if (command === "connect") {
    const agent = agentNameSchema.parse(subcommand);
    output({ ok: true, operation: "connect", agent, ...connectAgent(agent, config, serverPath, process.env, flag("force")) });
    return;
  }
  if (command === "disconnect") {
    const agent = agentNameSchema.parse(subcommand);
    disconnectAgent(agent, config); output({ ok: true, operation: "disconnect", agent }); return;
  }
  if (command === "doctor") {
    const result = await runDoctor(config, serverPath); output(result); if (!result.ok) process.exitCode = 1; return;
  }
  if (command === "database") {
    if (subcommand === "check") { output(inspectSqliteDatabase(config.databasePath)); return; }
    if (subcommand === "backup") {
      const destination = option("output"); if (!destination) throw new Error("--output <file> is required");
      output({ ok: true, operation: "database_backup", ...backupSqliteDatabase(config.databasePath, destination) }); return;
    }
    if (subcommand === "restore") {
      const backup = commandArgs[2]; if (!backup) throw new Error("backup-file is required");
      if (!flag("yes")) throw new Error("Refusing to switch the configured database without --yes");
      const extension = extname(config.databasePath) || ".db";
      const stem = basename(config.databasePath, extension);
      const restoredPath = option("output") || join(dirname(config.databasePath), `${stem}.restored-${new Date().toISOString().replaceAll(":", "-")}${extension}`);
      const restored = restoreSqliteDatabase(backup, restoredPath);
      const previousDatabasePath = config.databasePath;
      const agentsToReconnect = Object.keys(config.connectedAgents);
      const connectedAgents = Object.fromEntries(Object.entries(config.connectedAgents).map(([agent, connection]) => [
        agent, connection ? { ...connection, databasePath: connection.databasePath ?? previousDatabasePath } : connection,
      ]));
      saveConfig({ ...config, databasePath: restored.databasePath, connectedAgents });
      output({ ok: true, operation: "database_restore", ...restored, previousDatabasePath, agentsToReconnect, warning: agentsToReconnect.length
        ? "Reconnect each listed Agent with `open-continuity connect <agent> --force`, then restart that client. The previous database was not modified."
        : "The previous database was not modified." }); return;
    }
    throw new Error(`Unknown database command: ${subcommand || ""}`);
  }
  if (command === "export") {
    const directory = option("output"); if (!directory) throw new Error("--output <directory> is required");
    output({ ok: true, operation: "export", output: resolve(directory), manifest: exportMemoryPackage(config.databasePath, directory, { userId: config.userId }) }); return;
  }
  if (command === "import") {
    const directory = subcommand; if (!directory) throw new Error("Memory Package directory is required");
    output({ ok: true, operation: "import", input: resolve(directory), manifest: importMemoryPackage(directory, config.databasePath, { targetUserId: config.userId }) }); return;
  }
  if (command !== "memories") throw new Error(`Unknown command: ${command}`);

  const store = new SqliteMemoryStore(config.databasePath);
  try {
    if (subcommand === "list") {
      const kind = option("kind");
      output({ memories: store.inspectUserMemories({
        userId: config.userId, query: option("query"),
        kind: kind ? z.enum(["user_preference", "user_fact", "task_state", "decision"]).parse(kind) : undefined,
        limit: Number(option("limit") || 20), includePrivate: flag("private"),
      }) });
      return;
    }
    const memoryId = commandArgs[2]; if (!memoryId) throw new Error("memory-id is required");
    if (subcommand === "show") {
      const events = store.inspectUserHistory({ userId: config.userId, memoryId, limit: 100, includePrivate: flag("private") });
      const current = store.inspectUserMemories({ userId: config.userId, memoryId, limit: 1, includePrivate: flag("private") })[0] ?? null;
      if (!events.length) throw new Error("Memory not found");
      output({ memoryId, current, latestEvent: events[0], historyCount: events.length }); return;
    }
    if (subcommand === "history") {
      output({ events: store.inspectUserHistory({ userId: config.userId, memoryId, limit: Number(option("limit") || 100), includePrivate: flag("private") }) }); return;
    }
    if (subcommand === "forget") {
      if (!flag("yes")) throw new Error("Refusing to forget memory without --yes");
      output(store.forgetOwnedMemory(config.userId, memoryId)); return;
    }
    throw new Error(`Unknown memories command: ${subcommand || ""}`);
  } finally { store.close(); }
}

main().catch((error) => {
  const response = error instanceof z.ZodError
    ? { error: { code: "VALIDATION_ERROR", message: error.issues.map((issue) => issue.message).join("; ") } }
    : error instanceof OpenContinuityError ? errorResponse(error)
      : { error: { code: "CLI_ERROR", message: error instanceof Error ? error.message : String(error) } };
  console.error(jsonOutput ? JSON.stringify(response) : `Error: ${response.error.message}`);
  process.exitCode = 1;
});
