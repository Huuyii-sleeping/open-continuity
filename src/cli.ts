import { basename, dirname, extname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { agentNameSchema, ensureConfig, normalizeWorkspacePath, requireConfig, saveConfig } from "./cli/config.js";
import { connectAgent, detectAgents, disconnectAgent } from "./cli/connectors.js";
import { runDemo } from "./cli/demo.js";
import { runDoctor } from "./cli/doctor.js";
import { doctorClaudeAdapter, setupClaudeAdapter, type ClaudeAdapterPaths } from "./cli/claude-adapter.js";
import { doctorCodexAdapter, setupCodexAdapter, type CodexAdapterPaths } from "./cli/codex-adapter.js";
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
import { captureCodexStatus, codexCaptureDoctor, syncCodexCapture } from "./capture/codex-capture-service.js";
import { captureLockStatus } from "./capture/capture-lock.js";
import { captureServicePaths, installCaptureService, startCaptureService, statusCaptureService, stopCaptureService, uninstallCaptureService } from "./capture/capture-service.js";
import { watchTraeCapture } from "./capture/trae-watch.js";
import { ConversationInbox } from "./capture/conversation-inbox.js";
import { captureDatabasePath } from "./capture/paths.js";
import { TraeInjectionAdapter } from "./injection/trae-hook-config.js";
import { CodexInjectionAdapter } from "./injection/codex-hook-config.js";
import { cleanupInjectionReceipts, injectionReceiptStatus, purgeInjectionReceipts } from "./injection/receipt-store.js";
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
  open-continuity setup <trae|claude|codex> [--workspace <path>] [--force]
  open-continuity doctor [trae|claude|codex] [--workspace <path>]
  open-continuity injection status
  open-continuity injection enable <workspace>
  open-continuity injection disable
  open-continuity injection check-hook
  open-continuity injection install-hook
  open-continuity capture doctor [--source trae|codex]
  open-continuity capture status [--source trae|claude|codex]
  open-continuity capture enable <workspace>
  open-continuity capture disable
  open-continuity capture service <install|start|stop|status|uninstall>
  open-continuity capture sync [--source trae|codex] [--thread <thread-id>] [--limit n]
  open-continuity capture candidates [--status pending|approved|rejected] [--limit n]
  open-continuity capture thread <thread-id> [--source trae|claude|codex]
  open-continuity capture approve <candidate-id> [--share] [--replace-memory <memory-id>]
  open-continuity capture reject <candidate-id>
  open-continuity data status
  open-continuity data cleanup
  open-continuity data purge-transient --yes
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

  const runtimeDirectory = dirname(fileURLToPath(import.meta.url));
  const traeAdapterPaths: TraeAdapterPaths = {
    cliPath: join(dirname(fileURLToPath(import.meta.url)), "cli.js"), serverPath,
    injectionHookPath: join(dirname(fileURLToPath(import.meta.url)), "injection-hook.js"), nodePath: process.execPath,
  };
  const claudeAdapterPaths: ClaudeAdapterPaths = {
    serverPath, nodePath: process.execPath,
    injectionHookPath: join(runtimeDirectory, "claude-injection-hook.js"),
    captureHookPath: join(runtimeDirectory, "claude-capture-hook.js"),
  };
  const codexAdapterPaths: CodexAdapterPaths = {
    serverPath, nodePath: process.execPath,
    injectionHookPath: join(runtimeDirectory, "codex-injection-hook.js"),
    captureHookPath: join(runtimeDirectory, "codex-capture-hook.js"),
  };
  const requestedInjectionAgent = option("agent") || option("source") || "trae";
  const injectionAdapter = requestedInjectionAgent === "codex"
    ? new CodexInjectionAdapter(process.env, process.execPath, codexAdapterPaths)
    : new TraeInjectionAdapter(process.env, process.execPath, traeAdapterPaths.injectionHookPath);
  const config = command === "setup" ? ensureConfig().config : requireConfig();
  if (command === "setup") {
    const workspace = option("workspace") || process.cwd();
    const result = subcommand === "trae"
      ? await setupTraeAdapter(config, traeAdapterPaths, { workspace, force: flag("force") })
      : subcommand === "claude"
        ? await setupClaudeAdapter(config, claudeAdapterPaths, { workspace, force: flag("force") })
        : subcommand === "codex"
          ? await setupCodexAdapter(config, codexAdapterPaths, { workspace, force: flag("force") })
        : (() => { throw new Error(`Unknown setup target: ${subcommand || ""}`); })();
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
      const result = await doctorTraeAdapter(config, traeAdapterPaths, process.env, option("workspace"));
      output(result); if (!result.ok) process.exitCode = 1; return;
    }
    if (subcommand === "claude") {
      const result = await doctorClaudeAdapter(config, claudeAdapterPaths, process.env, option("workspace"));
      output(result); if (!result.ok) process.exitCode = 1; return;
    }
    if (subcommand === "codex") {
      const result = await doctorCodexAdapter(config, codexAdapterPaths, process.env, option("workspace"));
      output(result); if (!result.ok) process.exitCode = 1; return;
    }
    if (subcommand) throw new Error(`Unknown doctor target: ${subcommand}`);
    const result = await runDoctor(config, serverPath); output(result); if (!result.ok) process.exitCode = 1; return;
  }
  if (command === "injection") {
    if (subcommand === "status") {
      output({
        ok: true, operation: "injection_status", config: config.injection,
        hook: { event: injectionAdapter.hookEvent, ...injectionAdapter.check() },
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
      const result = injectionAdapter.check();
      output({ ok: result.valid && result.installed, operation: "injection_check_hook", ...result });
      if (!result.valid || !result.installed) process.exitCode = 1;
      return;
    }
    if (subcommand === "install-hook") {
      const result = injectionAdapter.install();
      output({ ok: true, operation: "injection_install_hook", ...result });
      return;
    }
    throw new Error(`Unknown injection command: ${subcommand || ""}`);
  }
  if (command === "capture") {
    if (subcommand === "doctor") {
      const source = z.enum(["trae", "codex"]).parse(option("source") || "trae");
      const result = source === "codex" ? codexCaptureDoctor() : captureDoctor();
      output(result); if (!result.ok) process.exitCode = 1; return;
    }
    if (subcommand === "status") {
      const source = z.enum(["trae", "claude", "codex"]).parse(option("source") || "trae");
      const status = source === "codex" ? captureCodexStatus(process.env) : captureStatus(process.env, source);
      output({ ok: true, operation: "capture_status", config: config.capture, ...status,
        ...(source === "trae" ? { lock: captureLockStatus(), service: statusCaptureService() } : {}) });
      return;
    }
    if (subcommand === "enable") {
      const workspace = commandArgs[2]; if (!workspace) throw new Error("workspace is required");
      const normalized = normalizeWorkspacePath(workspace);
      const workspaces = [...new Set([...config.capture.workspaces.map(normalizeWorkspacePath), normalized])];
      config.capture = { ...config.capture, enabled: true, workspaces };
      saveConfig(config);
      output({ ok: true, operation: "capture_enable", config: config.capture });
      return;
    }
    if (subcommand === "disable") {
      config.capture = { ...config.capture, enabled: false };
      saveConfig(config);
      output({ ok: true, operation: "capture_disable", config: config.capture });
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
      const source = z.enum(["trae", "codex"]).parse(option("source") || "trae");
      const limit = z.coerce.number().int().min(1).max(100).parse(option("limit") || 10);
      const maxThreads = z.coerce.number().int().min(1).max(1000).parse(option("max-threads") || config.capture.maxThreads);
      const result = source === "codex"
        ? await syncCodexCapture({ threadId: option("thread"), limit, maxThreads })
        : await syncTraeCapture({ threadId: option("thread"), limit, maxThreads });
      output({ ok: true, operation: "capture_sync", ...result }); return;
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
      }, process.env, { memoryDatabasePath: config.databasePath, userId: config.userId }));
      return;
    }
    if (subcommand === "thread") {
      const threadId = commandArgs[2]; if (!threadId) throw new Error("thread-id is required");
      const source = z.enum(["trae", "claude", "codex"]).parse(option("source") || "trae");
      output({ ok: true, operation: "capture_thread", source, ...inspectCapturedThread(threadId, process.env, source) }); return;
    }
    const candidateId = commandArgs[2];
    if (!candidateId) throw new Error("candidate-id is required");
    if (subcommand === "approve") {
      output({ ok: true, operation: "capture_approve", ...await approveCaptureCandidate(candidateId, config, flag("share") ? "public" : "private", process.env, option("replace-memory")) }); return;
    }
    if (subcommand === "reject") { output({ ok: true, operation: "capture_reject", candidate: rejectCaptureCandidate(candidateId) }); return; }
    throw new Error("Unknown capture command: " + (subcommand || ""));
  }
  if (command === "data") {
    const inbox = new ConversationInbox(captureDatabasePath());
    try {
      if (subcommand === "status") {
        output({
          ok: true,
          operation: "data_status",
          policies: {
            conversationRetentionDays: config.capture.retentionDays,
            pendingCandidateRetentionDays: config.capture.pendingCandidateRetentionDays,
            receiptRetentionDays: config.injection.receiptRetentionDays,
            maxReceipts: config.injection.maxReceipts,
          },
          inbox: { path: captureDatabasePath(), ...inbox.governanceStatus() },
          receipts: injectionReceiptStatus(),
          longTermMemory: { path: config.databasePath, preservedByTransientCleanup: true },
        });
        return;
      }
      if (subcommand === "cleanup") {
        output({
          ok: true,
          operation: "data_cleanup",
          inbox: inbox.cleanupExpired(config.capture.retentionDays, Date.now(), config.capture.pendingCandidateRetentionDays),
          receipts: cleanupInjectionReceipts(process.env, config.injection),
          longTermMemoryPreserved: true,
        });
        return;
      }
      if (subcommand === "purge-transient") {
        if (!flag("yes")) throw new Error("Refusing to purge transient Capture and Receipt data without --yes");
        output({
          ok: true,
          operation: "data_purge_transient",
          inbox: inbox.purgeInbox(),
          receipts: purgeInjectionReceipts(),
          longTermMemoryPreserved: true,
        });
        return;
      }
      throw new Error(`Unknown data command: ${subcommand || ""}`);
    } finally {
      inbox.close();
    }
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
