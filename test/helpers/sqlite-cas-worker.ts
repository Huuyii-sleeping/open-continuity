import { MemoryService } from "../../src/core/memory-service.js";
import { SqliteMemoryStore } from "../../src/sqlite/sqlite-memory-store.js";

const databasePath = process.env.OPEN_CONTINUITY_TEST_SQLITE;
const index = process.env.OPEN_CONTINUITY_TEST_INDEX;
if (!databasePath || index === undefined) throw new Error("Missing SQLite CAS worker configuration");

const service = new MemoryService(new SqliteMemoryStore(databasePath));
try {
  const result = await service.remember({
    userId: "cas-user", agentId: `worker-${index}`, key: "shared-status", value: `value-${index}`,
    kind: "task_state", expectedVersion: 1, idempotencyKey: `sqlite-cas-${index}`,
  });
  process.stdout.write(JSON.stringify({ ok: true, version: result.current.version }));
} catch (error) {
  process.stdout.write(JSON.stringify({ ok: false, code: error && typeof error === "object" && "code" in error ? error.code : "UNKNOWN" }));
} finally {
  await service.close();
}
