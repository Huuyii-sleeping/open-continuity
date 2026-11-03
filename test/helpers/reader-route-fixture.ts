import { SqliteMemoryStore } from "../../src/storage/sqlite/sqlite-memory-store.js";
import { MemoryService } from "../../src/core/application/memory-service.js";
import type { RememberInput } from "../../src/shared/types.js";
import { routeActor } from "./core-route-fixtures.js";
export async function readerRouteFixture() {
  const store = new SqliteMemoryStore(":memory:"), service = new MemoryService(store);
  let counter = 0;
  const write = (key: string, value: string, extra: Partial<RememberInput> = {}) => service.remember({ ...routeActor, key, value, kind: "decision", userConfirmed: true, idempotencyKey: "fictional-route-" + ++counter, ...extra });
  try {
    await write("fictional-target", "needle needle needle");
    await write("fictional-pending", "needle", { userConfirmed: false });
    await write("fictional-private", "needle", { sensitivity: "private" });
    await write("fictional-target", "needle", { userId: "fictional-other-user" });
    await write("fictional-agent", "needle", { scope: "agent", agentId: "fictional-other-agent" });
    await write("fictional-task", "needle", { scope: "task", taskId: "fictional-other-task" });
    return { store, write, close: () => service.close() };
  } catch (error) { await service.close(); throw error; }
}
