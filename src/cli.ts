import { basename, dirname, extname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { agentNameSchema, ensureConfig, normalizeWorkspacePath, requireConfig, saveConfig } from "./cli/config.js";
import { connectAgent, detectAgents, disconnectAgent } from "./cli/connectors.js";
import { runDemo } from "./cli/demo.js";
import { runDoctor } from "./cli/doctor.js";
import { doctorTraeAdapter, setupTraeAdapter, type TraeAdapterPaths } from "./cli/trae-adapter.js";
import {
  approveCaptureCandidate,
  captureDoctor,
  inspectCapturedThread,
  listCaptureCandidates,
  captureStatus,
  rejectCaptureCandidate,
  syncTraeCapture,
} from "./capture/trae-capture-service.js";
import { captureLockStatus } from "./capture/capture-lock.js";
import { captureServicePaths, installCaptureService, startCaptureService, statusCaptureService, stopCaptureService, uninstallCaptureService } from "./capture/capture-service.js";
import { watchTraeCapture } from "./capture/trae-watch.js";
import { checkTraeInjectionHook, installTraeInjectionHook } from "./injection/trae-hook-config.js";
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
  open-continuity setup trae [--workspace <path>] [--force]
  open-continuity doctor [trae] [--workspace <path>]
  open-continuity injection status
  open-continuity injection enable <workspace>
  open-continuity injection disable
  open-continuity injection check-hook
  open-continuity injection install-hook
  open-continuity capture doctor
  open-continuity capture status
  open-continuity capture service <install|start|stop|status|uninstall>
  open-continuity capture sync [--thread <thread-id>] [--limit n]
  open-continuity capture candidates [--status pending|approved|rejected] [--limit n]
  open-continuity capture thread <thread-id>
  open-continuity capture approve <candidate-id> [--share]
  open-continuity capture reject <candidate-id>
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

  const adapterPaths: TraeAdapterPaths = {
    cliPath: join(dirname(fileURLToPath(import.meta.url)), "cli.js"), serverPath,
    injectionHookPath: join(dirname(fileURLToPath(import.meta.url)), "injection-hook.js"), nodePath: process.execPath,
  };
  const config = command === "setup" ? ensureConfig().config : requireConfig();
  if (command === "setup") {
    if (subcommand !== "trae") throw new Error(`Unknown setup target: ${subcommand || ""}`);
    const result = await setupTraeAdapter(config, adapterPaths, { workspace: option("workspace") || process.cwd(), force: flag("force") });
    output(result); if (!result.ok) process.exitCode = 1; return;
  }
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
    if (subcommand === "trae") {
      const result = await doctorTraeAdapter(config, adapterPaths, process.env, option("workspace"));
      output(result); if (!result.ok) process.exitCode = 1; return;
    }
    if (subcommand) throw new Error(`Unknown doctor target: ${subcommand}`);
    const result = await runDoctor(config, serverPath); output(result); if (!result.ok) process.exitCode = 1; return;
  }
  if (command === "injection") {
    if (subcommand === "status") {
      output({
        ok: true, operation: "injection_status", config: config.injection,
        hook: { event: "UserPromptSubmit", ...checkTraeInjectionHook(process.env, process.execPath, join(dirname(fileURLToPath(import.meta.url)), "injection-hook.js")) },
      });
      return;
    }
    if (subcommand === "enable") {
      const workspace = commandArgs[2]; if (!workspace) throw new Error("workspace is required");
      const normalized = normalizeWorkspacePath(workspace);
      const workspaces = [...new Set([...config.injection.workspaces.map(normalizeWorkspacePath), normalized])];
      config.injection = { ...config.injection, enabled: true, workspaces };
      saveConfig(config);
      output({ ok: true, operation: "injection_enable", config: config.injection });
      return;
    }
    if (subcommand === "disable") {
      config.injection = { ...config.injection, enabled: false };
      saveConfig(config);
      output({ ok: true, operation: "injection_disable", config: config.injection });
      return;
    }
    if (subcommand === "check-hook") {
      const result = checkTraeInjectionHook(process.env, process.execPath, join(dirname(fileURLToPath(import.meta.url)), "injection-hook.js"));
      output({ ok: result.valid && result.installed, operation: "injection_check_hook", ...result });
      if (!result.valid || !result.installed) process.exitCode = 1;
      return;
    }
    if (subcommand === "install-hook") {
      const result = installTraeInjectionHook(process.env, process.execPath, join(dirname(fileURLToPath(import.meta.url)), "injection-hook.js"));
      output({ ok: true, operation: "injection_install_hook", ...result });
      return;
    }
    throw new Error(`Unknown injection command: ${subcommand || ""}`);
  }
  if (command === "capture") {
    if (subcommand === "doctor") {
      const result = captureDoctor(); output(result); if (!result.ok) process.exitCode = 1; return;
    }
    if (subcommand === "status") {
      output({ ok: true, operation: "capture_status", ...captureStatus(), lock: captureLockStatus(), service: statusCaptureService() });
      return;
    }
    if (subcommand === "service") {
      const serviceOperation = commandArgs[2];
      if (serviceOperation === "install") {
        const captureConfig = config.capture;
        output({ ok: true, operation: "capture_service_install", ...installCaptureService({ nodePath: process.execPath, cliPath: join(dirname(fileURLToPath(import.meta.url)), "cli.js"), config: { intervalMs: captureConfig.intervalMs, pageSize: captureConfig.pageSize, maxThreads: captureConfig.maxThreads, retryLimit: captureConfig.retryLimit } }) });
        return;
      }
      if (serviceOperation === "start") { output({ ok: true, operation: "capture_service_start", ...startCaptureService() }); return; }
      if (serviceOperation === "stop") { output({ ok: true, operation: "capture_service_stop", ...stopCaptureService() }); return; }
      if (serviceOperation === "status") { output({ ok: true, operation: "capture_service_status", ...statusCaptureService(), paths: captureServicePaths() }); return; }
      if (serviceOperation === "uninstall") { output({ ok: true, operation: "capture_service_uninstall", ...uninstallCaptureService() }); return; }
      throw new Error("Unknown capture service operation: " + (serviceOperation || ""));
    }
    if (subcommand === "sync") {
      const limit = z.coerce.number().int().min(1).max(100).parse(option("limit") || 10);
      const maxThreads = z.coerce.number().int().min(1).max(1000).parse(option("max-threads") || config.capture.maxThreads);
      output({ ok: true, operation: "capture_sync", ...await syncTraeCapture({ threadId: option("thread"), limit, maxThreads }) }); return;
    }
    if (subcommand === "watch") {
      const limit = z.coerce.number().int().min(1).max(100).parse(option("limit") || 10);
      const intervalMs = z.coerce.number().int().min(1000).max(86_400_000).parse(option("interval") || config.capture.intervalMs);
      const maxThreads = z.coerce.number().int().min(1).max(1000).parse(option("max-threads") || config.capture.maxThreads);
      const retryLimit = z.coerce.number().int().min(0).max(10).parse(option("retry-limit") || config.capture.retryLimit);
      const controller = new AbortController();
      const stop = () => controller.abort();
      process.once("SIGINT", stop); process.once("SIGTERM", stop);
      try {
        await watchTraeCapture({ limit, intervalMs, maxThreads, retryLimit, once: flag("once"), onCycle: (result) => output({ ok: true, operation: "capture_watch_cycle", ...result }) }, process.env, controller.signal);
      } finally { process.removeListener("SIGINT", stop); process.removeListener("SIGTERM", stop); }
      return;
    }
    if (subcommand === "candidates") {
      const status = option("status");
      output(listCaptureCandidates({
        status: status ? z.enum(["pending", "approved", "rejected"]).parse(status) : undefined,
        limit: z.coerce.number().int().min(1).max(500).parse(option("limit") || 50),
      }));
      return;
    }
    if (subcommand === "thread") {
      const threadId = commandArgs[2]; if (!threadId) throw new Error("thread-id is required");
      output({ ok: true, operation: "capture_thread", ...inspectCapturedThread(threadId) }); return;
    }
    const candidateId = commandArgs[2];
    if (!candidateId) throw new Error("candidate-id is required");
    if (subcommand === "approve") {
      output({ ok: true, operation: "capture_approve", ...await approveCaptureCandidate(candidateId, config, flag("share") ? "public" : "private") }); return;
    }
    if (subcommand === "reject") { output({ ok: true, operation: "capture_reject", candidate: rejectCaptureCandidate(candidateId) }); return; }
    throw new Error("Unknown capture command: " + (subcommand || ""));
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
