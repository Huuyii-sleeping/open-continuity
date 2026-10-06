import { DataType, newDb } from "pg-mem";
import { afterEach, describe, expect, it } from "vitest";
import { MemoryService } from "../src/core/memory-service.js";
import { PostgresMemoryStore, type DatabasePool } from "../src/postgres/postgres-memory-store.js";

function createPool(): DatabasePool {
  const database = newDb({ autoCreateForeignKeyIndices: true });
  database.public.registerFunction({ name: "pg_advisory_xact_lock", args: [DataType.integer], returns: DataType.integer, implementation: () => 1 });
  const adapter = database.adapters.createPg();
  return new adapter.Pool();
}

describe("PostgresMemoryStore", () => {
  const services: MemoryService[] = [];

  afterEach(async () => {
    await Promise.all(services.splice(0).map((service) => service.close()));
  });

  it("persists current state and event history across service instances", async () => {
    const pool = createPool();
    const firstStore = new PostgresMemoryStore(pool);
    await firstStore.initialize();
    const codex = new MemoryService(firstStore);
    const claude = new MemoryService(new PostgresMemoryStore(pool, { autoMigrate: false }));
    services.push(codex, claude);

    const first = await codex.remember({ userId: "u1", agentId: "codex", key: "response_style", value: "concise", kind: "user_preference", idempotencyKey: "pg-1" });
    expect((await claude.recall({ userId: "u1", agentId: "claude" })).memories[0]?.value).toBe("concise");
    const second = await claude.remember({ userId: "u1", agentId: "claude", key: "response_style", value: "detailed", kind: "user_preference", idempotencyKey: "pg-2" });

    expect(second.current.id).toBe(first.current.id);
    expect(second.current.version).toBe(2);
    expect((await codex.recall({ userId: "u1", agentId: "codex" })).memories[0]?.value).toBe("detailed");
    expect((await codex.history({ userId: "u1", agentId: "codex", memoryId: first.current.id })).events).toHaveLength(2);
  });

  it("enforces idempotency, scope, private filtering, pagination, and forget transaction", async () => {
    const pool = createPool();
    const service = new MemoryService(new PostgresMemoryStore(pool));
    services.push(service);

    const sharedInput = { userId: "u1", agentId: "codex", key: "shared", value: "visible", kind: "user_fact" as const, idempotencyKey: "pg-idempotent" };
    const shared = await service.remember(sharedInput);
    expect((await service.remember(sharedInput)).duplicate).toBe(true);
    await expect(service.remember({ ...sharedInput, value: "different" })).rejects.toMatchObject({ code: "IDEMPOTENCY_CONFLICT" });
    expect((await service.recall({ userId: "u1", agentId: "codex", key: "shared" })).memories[0]?.value).toBe("visible");
    expect((await service.history({ userId: "u1", agentId: "codex", memoryId: shared.current.id })).events).toHaveLength(1);

    await service.remember({ userId: "u1", agentId: "codex", key: "task", value: "task-only", kind: "task_state", scope: "task", taskId: "t1", idempotencyKey: "pg-task" });
    await service.remember({ userId: "u1", agentId: "codex", key: "agent", value: "codex-only", kind: "user_fact", scope: "agent", idempotencyKey: "pg-agent" });
    await service.remember({ userId: "u1", agentId: "codex", key: "secret", value: "hidden", kind: "user_fact", sensitivity: "private", idempotencyKey: "pg-private" });

    expect((await service.recall({ userId: "u1", agentId: "claude", limit: 1 })).memories.map((memory) => memory.value)).toEqual(["visible"]);
    expect((await service.recall({ userId: "u1", agentId: "claude", taskId: "t1", limit: 10 })).memories.map((memory) => memory.value).sort()).toEqual(["task-only", "visible"]);
    const firstPage = await service.recall({ userId: "u1", agentId: "codex", taskId: "t1", includePrivate: true, limit: 2 });
    const secondPage = await service.recall({ userId: "u1", agentId: "codex", taskId: "t1", includePrivate: true, limit: 2, cursor: firstPage.nextCursor! });
    expect(firstPage.nextCursor).not.toBeNull();
    expect(new Set([...firstPage.memories, ...secondPage.memories].map((memory) => memory.id)).size).toBe(4);
    expect((await service.recall({ userId: "u1", agentId: "codex", query: "codex-only" })).memories.map((memory) => memory.key)).toEqual(["agent"]);
    expect((await service.history({ userId: "u1", agentId: "claude", limit: 10 })).events.every((event) => event.sensitivity === "public")).toBe(true);

    await service.forget({ userId: "u1", agentId: "claude", memoryId: shared.current.id });
    expect((await service.recall({ userId: "u1", agentId: "claude" })).memories).toHaveLength(0);
    expect((await service.history({ userId: "u1", agentId: "claude", memoryId: shared.current.id })).events).toHaveLength(2);
  });

  it("serializes concurrent updates to one logical memory without losing events", async () => {
    const pool = createPool();
    const store = new PostgresMemoryStore(pool);
    await store.initialize();
    const servicesForWorkers = Array.from({ length: 6 }, () => new MemoryService(new PostgresMemoryStore(pool, { autoMigrate: false })));
    services.push(...servicesForWorkers);

    const receipts = await Promise.all(servicesForWorkers.map((service, index) => service.remember({
      userId: "u-concurrent", agentId: "agent-" + index, key: "status", value: "value-" + index,
      kind: "task_state", idempotencyKey: "pg-concurrent-" + index,
    })));
    const reader = servicesForWorkers[0];
    const current = await reader.recall({ userId: "u-concurrent", agentId: "reader" });
    const history = await reader.history({ userId: "u-concurrent", agentId: "reader", limit: 100 });

    expect(new Set(receipts.map((receipt) => receipt.current.id)).size).toBe(1);
    expect(current.memories).toHaveLength(1);
    expect(current.memories[0].version).toBe(6);
    expect(history.events).toHaveLength(6);
  });

  it("allows only one concurrent compare-and-set update for the same version", async () => {
    const pool = createPool();
    const seed = new MemoryService(new PostgresMemoryStore(pool));
    services.push(seed);
    await seed.remember({ userId: "cas-user", agentId: "seed", key: "status", value: "initial", kind: "task_state", expectedVersion: 0, idempotencyKey: "pg-cas-seed" });
    const writers = [0, 1].map((index) => new MemoryService(new PostgresMemoryStore(pool, { autoMigrate: false })));
    services.push(...writers);

    const results = await Promise.allSettled(writers.map((service, index) => service.remember({
      userId: "cas-user", agentId: `writer-${index}`, key: "status", value: `value-${index}`,
      kind: "task_state", expectedVersion: 1, idempotencyKey: `pg-cas-${index}`,
    })));

    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    const rejected = results.find((result) => result.status === "rejected");
    expect(rejected).toMatchObject({ status: "rejected", reason: { code: "VERSION_CONFLICT" } });
    expect((await seed.recall({ userId: "cas-user", agentId: "reader", key: "status" })).memories[0].version).toBe(2);
    expect((await seed.history({ userId: "cas-user", agentId: "reader" })).events).toHaveLength(2);
  });
});
