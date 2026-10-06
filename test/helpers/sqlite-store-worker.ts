import { MemoryService } from "../../src/core/memory-service.js";
import { SqliteMemoryStore } from "../../src/sqlite/sqlite-memory-store.js";

const databasePath = process.env.OPEN_CONTINUITY_TEST_SQLITE;
const index = process.env.OPEN_CONTINUITY_TEST_INDEX;
if (!databasePath || index === undefined) throw new Error("Missing SQLite worker configuration");

const service = new MemoryService(new SqliteMemoryStore(databasePath));
try {
  await service.remember({
    userId: "concurrent-user", agentId: `worker-${index}`, key: "shared-status", value: `value-${index}`,
    kind: "user_fact", idempotencyKey: `sqlite-worker-${index}`,
  });
} finally {
  await service.close();
}
