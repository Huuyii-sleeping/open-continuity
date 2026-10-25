import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { MemoryService } from "../src/core/memory-service.js";
import { SqliteMemoryStore } from "../src/sqlite/sqlite-memory-store.js";
import { backupSqliteDatabase, inspectSqliteDatabase, restoreSqliteDatabase } from "../src/sqlite/maintenance.js";

const actor = { userId: "fictional-process-user", agentId: "fictional-process-agent" };
const initial = { ...actor, key: "fictional-status", value: "fictional oldmarker", kind: "decision" as const, userConfirmed: true, expectedVersion: 0, idempotencyKey: "fictional-initial" };
type Message = { state: string; duplicate?: boolean; version?: number };
const directories: string[] = [];
const services: MemoryService[] = [];
afterEach(async () => {
  for (const service of services.splice(0)) await service.close();
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});
function database() { const directory = mkdtempSync(join(tmpdir(), "open-continuity-reliability-")); directories.push(directory); return join(directory, "fictional.db"); }
function reader(path: string) { const service = new MemoryService(new SqliteMemoryStore(path, { busyTimeoutMs: 100 })); services.push(service); return service; }
function worker(path: string, mode: string, index = 0, crash = false) {
  return new Promise<Message[]>((resolve, reject) => {
    const child = spawn(process.execPath, ["--import", "tsx/esm", join(process.cwd(), "test/helpers/reliability-sqlite-worker.ts"), path, mode, String(index)],
      { cwd: process.cwd(), stdio: ["ignore", "pipe", "ignore"], env: { ...process.env } });
    let output = ""; let killedAtBoundary = false;
    const watchdog = setTimeout(() => { child.kill("SIGKILL"); reject(new Error("Fictional worker exceeded its bounded test budget")); }, 15000);
    child.stdout.on("data", chunk => {
      output += String(chunk);
      if (crash && /"state":"(?:uncommitted|committed)"/.test(output)) { killedAtBoundary = true; child.kill("SIGKILL"); }
    });
    child.once("error", error => { clearTimeout(watchdog); reject(error); });
    child.once("exit", (code, signal) => {
      clearTimeout(watchdog);
      if ((crash && (!killedAtBoundary || signal !== "SIGKILL")) || (!crash && code !== 0)) return reject(new Error("Fictional worker failed"));
      try { resolve(output.trim().split("\n").filter(Boolean).map(line => JSON.parse(line) as Message)); } catch { reject(new Error("Invalid fictional worker receipt")); }
    });
  });
}
function consistency(path: string) {
  const db = new DatabaseSync(path, { readOnly: true });
  try {
    expect(db.prepare("PRAGMA integrity_check").get()!.integrity_check).toBe("ok");
    expect(db.prepare("SELECT COUNT(*) AS n FROM memories_current m LEFT JOIN memory_events e ON e.id=m.source_event_id WHERE e.id IS NULL OR m.version<>e.memory_version OR m.value<>e.value").get()!.n).toBe(0);
    expect(db.prepare("SELECT COUNT(*) AS n FROM memories_current m LEFT JOIN memories_fts f ON f.memory_id=m.id WHERE f.memory_id IS NULL OR f.memory_key<>m.memory_key OR f.value_text<>m.value").get()!.n).toBe(0);
    expect(db.prepare("SELECT COUNT(*) AS n FROM memories_fts f LEFT JOIN memories_current m ON m.id=f.memory_id WHERE m.id IS NULL").get()!.n).toBe(0);
  } finally { db.close(); }
}

describe("5B real-process SQLite reliability", () => {
  it("concurrent identical create requests publish exactly one version and event", async () => {
    const path = database(); const service = reader(path);
    const rows = (await Promise.all(Array.from({ length: 4 }, (_, n) => worker(path, "duplicate", n)))).flat();
    expect(rows.filter(row => row.state === "written" && !row.duplicate)).toHaveLength(1);
    expect(rows.filter(row => row.duplicate)).toHaveLength(3);
    expect((await service.history(actor)).events).toHaveLength(1);
    expect((await service.recall(actor)).memories[0]?.version).toBe(1); consistency(path);
  }, 20000);
  it("concurrent stale-version writes have one winner and explicit CAS conflicts", async () => {
    const path = database(); const service = reader(path); await service.remember(initial);
    const rows = (await Promise.all(Array.from({ length: 4 }, (_, n) => worker(path, "cas", n)))).flat();
    expect(rows.filter(row => row.state === "written")).toHaveLength(1);
    expect(rows.filter(row => row.state === "version_conflict")).toHaveLength(3);
    expect((await service.history(actor)).events).toHaveLength(2); consistency(path);
  }, 20000);
  for (const boundary of ["before", "after"] as const) {
    it(`recovers current/event/FTS state after process death ${boundary} COMMIT and safely retries`, async () => {
      const path = database(); const service = reader(path); await service.remember(initial);
      await worker(path, `crash_${boundary}`, 0, true);
      consistency(path);
      const reopened = reader(path);
      const before = (await reopened.recall(actor)).memories[0]!;
      expect(before.version).toBe(boundary === "before" ? 1 : 2);
      expect((await reopened.recall({ ...actor, query: boundary === "before" ? "oldmarker" : "newmarker" })).memories).toHaveLength(1);
      expect((await reopened.recall({ ...actor, query: boundary === "before" ? "newmarker" : "oldmarker" })).memories).toHaveLength(0);
      const retried = await reopened.remember({ ...initial, value: "fictional newmarker", expectedVersion: 1, idempotencyKey: "fictional-crash-update" });
      expect(retried.duplicate).toBe(boundary === "after"); expect(retried.current.version).toBe(2);
      expect((await reopened.history(actor)).events).toHaveLength(2); consistency(path);
    }, 20000);
  }
  it("reports lock failures without partial publication and can retry the same request", async () => {
    const path = database(); const service = reader(path); await service.remember(initial);
    const lock = new DatabaseSync(path); lock.exec("BEGIN IMMEDIATE");
    const update = { ...initial, value: "fictional locked update", expectedVersion: 1, idempotencyKey: "fictional-lock-update" };
    try { await expect(service.remember(update)).rejects.toMatchObject({ code: "STORAGE_ERROR" }); }
    finally { lock.exec("ROLLBACK"); lock.close(); }
    expect((await service.history(actor)).events).toHaveLength(1);
    expect((await service.remember(update)).current.version).toBe(2); consistency(path);
    expect(() => new SqliteMemoryStore(path, { busyTimeoutMs: -1 })).toThrow("lock-wait budget");
  });
  it("preserves authorized version citations or reports snapshot inconsistency during writer churn", async () => {
    const path = database(); const service = reader(path);
    await service.remember({ ...initial, key: "fictional-churn", value: "fictional needle initial", idempotencyKey: "fictional-churn-initial" });
    for (const [n, extra] of [{ userId: "fictional-other-user" }, { scope: "agent" as const, agentId: "fictional-other-agent" },
      { scope: "task" as const, taskId: "fictional-other-task" }, { sensitivity: "private" as const }].entries()) {
      await service.remember({ ...initial, ...extra, key: `fictional-forbidden-${n}`, value: "fictional needle forbidden", idempotencyKey: `fictional-forbidden-${n}` });
    }
    const writer = worker(path, "churn"); let checked = 0;
    for (let n = 0; n < 100; n++) {
      try {
        const result = await service.query({ ...actor, agentId: "fictional-reader", query: "needle" });
        expect(result.contextPack.items.map(item => item.key)).toEqual(["fictional-churn"]);
        const item = result.contextPack.items[0]!; const citation = result.answer!.citations[0]!;
        expect(citation).toMatchObject({ memoryId: item.memoryId, sourceEventId: item.sourceEventId, version: item.version });
        checked++;
      } catch (error) {
        if (!(error instanceof Error) || !("code" in error) || error.code !== "STORAGE_ERROR") throw error;
        expect(error.message).toMatch(/Inconsistent|inconsistent/);
      }
      await new Promise<void>(resolve => setTimeout(resolve, 2));
    }
    await writer; expect(checked).toBeGreaterThan(0); consistency(path);
    const result = await service.query({ ...actor, query: "needle" }); expect(result.answer!.status).toBe("evidence_ready");
    expect((await service.recall({ ...actor, key: "fictional-churn" })).memories[0]?.version).toBe(61);
  }, 20000);
  it("restores a WAL backup to a new path with versions, events, FTS and permissions intact", async () => {
    const path = database(); const service = reader(path); const receipt = await service.remember(initial);
    await service.remember({ ...initial, key: "fictional-private", value: "fictional oldmarker private", sensitivity: "private", idempotencyKey: "fictional-backup-private" });
    const backup = join(directories.at(-1)!, "backup.db"); const restored = join(directories.at(-1)!, "restored.db");
    backupSqliteDatabase(path, backup);
    await service.forget({ ...actor, memoryId: receipt.current.id });
    restoreSqliteDatabase(backup, restored); consistency(restored);
    expect(inspectSqliteDatabase(path)).toMatchObject({ memories: 1, events: 3 });
    const snapshot = reader(restored);
    const query = await snapshot.query({ ...actor, query: "oldmarker" });
    expect(query.contextPack.items.map(item => item.key)).toEqual(["fictional-status"]);
    expect(query.answer!.citations[0]).toMatchObject({ memoryId: receipt.current.id, version: 1, sourceEventId: receipt.event.id });
    expect((await snapshot.history(actor)).events).toHaveLength(1);
    expect(() => restoreSqliteDatabase(backup, path)).toThrow("already exists");
  });
});
