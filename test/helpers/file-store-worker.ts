import { MemoryService } from "../../src/core/memory-service.js";
import { JsonFileStore } from "../../src/core/memory-store.js";

const filePath = process.env.OPEN_CONTINUITY_TEST_FILE;
const index = process.env.OPEN_CONTINUITY_TEST_INDEX;
if (!filePath || !index) throw new Error("Worker requires OPEN_CONTINUITY_TEST_FILE and OPEN_CONTINUITY_TEST_INDEX");

const service = new MemoryService(new JsonFileStore(filePath));
const result = await service.remember({
  userId: "concurrent-user",
  agentId: "worker-" + index,
  key: "concurrent-key-" + index,
  value: index,
  kind: "user_fact",
  idempotencyKey: "concurrent-request-" + index,
});
process.stdout.write(JSON.stringify({ eventId: result.event.id }));
