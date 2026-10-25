import { writeSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { MemoryService } from "../../src/core/memory-service.js";
import { SqliteMemoryStore } from "../../src/sqlite/sqlite-memory-store.js";

const [path, mode, index = "0"] = process.argv.slice(2);
if (!path || !mode || !/fictional\.db$/.test(path)) throw new Error("Explicit fictional database required");
const signal = (value: object) => writeSync(1, JSON.stringify(value) + "\n");
const actor = { userId: "fictional-process-user", agentId: "fictional-process-agent" };
let armed = false;
const original = DatabaseSync.prototype.exec;
// Test-only process death at the real Store COMMIT boundary, after current/event/FTS writes.
if (mode === "crash_before" || mode === "crash_after") {
  DatabaseSync.prototype.exec = function(sql) {
    if (armed && sql === "COMMIT" && mode === "crash_before") {
      signal({ state: "uncommitted" }); Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0);
    }
    original.call(this, sql);
    if (armed && sql === "COMMIT" && mode === "crash_after") {
      signal({ state: "committed" }); Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0);
    }
  };
}
try {
  const service = new MemoryService(new SqliteMemoryStore(path, { busyTimeoutMs: 2000 }));
  armed = true;
  if (mode.startsWith("crash_")) {
    await service.remember({ ...actor, key: "fictional-status", value: "fictional newmarker", kind: "decision",
      userConfirmed: true, expectedVersion: 1, idempotencyKey: "fictional-crash-update" });
  } else if (mode === "duplicate" || mode === "cas") {
    try {
      const receipt = await service.remember({ ...actor, key: "fictional-status", value: mode === "cas" ? `fictional cas-${index}` : "fictional duplicate-marker",
        kind: "decision", userConfirmed: true, expectedVersion: mode === "cas" ? 1 : 0,
        idempotencyKey: mode === "cas" ? `fictional-cas-${index}` : "fictional-shared-request" });
      signal({ state: "written", duplicate: receipt.duplicate, version: receipt.current.version });
    } catch (error) {
      if (mode === "cas" && error instanceof Error && "code" in error && error.code === "VERSION_CONFLICT") signal({ state: "version_conflict" });
      else throw error;
    }
  } else if (mode === "churn") {
    for (let n = 0; n < 60; n++) {
      await service.remember({ ...actor, key: "fictional-churn", value: `fictional needle ${n}`, kind: "decision", userConfirmed: true, idempotencyKey: `fictional-churn-${n}` });
      if (n % 5 === 0) await new Promise<void>(resolve => setTimeout(resolve, 2));
    }
    signal({ state: "churn_done" });
  } else throw new Error("Unknown fictional worker mode");
  await service.close();
} catch {
  signal({ state: "failed" }); process.exitCode = 1;
}
