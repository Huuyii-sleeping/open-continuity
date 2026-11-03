import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { loadCandidateDataset } from "../../../evals/candidates/dataset.js";
import { MemoryService } from "../../../src/core/application/memory-service.js";
import { SqliteMemoryStore } from "../../../src/storage/sqlite/sqlite-memory-store.js";
import { InMemoryStore } from "../../../src/storage/inmemory/store.js";
import { capabilitiesWithServiceSupport } from "../../../src/core/application/capabilities.js";
import { developmentCapabilities } from "../../../src/core/runtime/profile.js";

const cases = loadCandidateDataset(join(process.cwd(), "evals/datasets/literal-value-v1.json"));
const actor = { userId: "fictional-literal-user", agentId: "fictional-literal-reader" };
describe("SQLite literal values at public endpoints", () => {
  for (const scenario of cases) {
    it(scenario.spec.id, async () => {
      const store = new SqliteMemoryStore(":memory:");
      const service = new MemoryService(store, {}, { defaultTokenBudget: 4096, maxTokenBudget: 4096, maxMemories: 10, requireUserConfirmed: true });
      try {
        const seeds = scenario.spec.memories;
        if (!seeds?.length) throw new Error("Literal fixtures require seeded memories");
        const memory = seeds[0]!;
        for (const [index, item] of seeds.entries()) await service.remember({
          userId: item.userId ?? actor.userId, agentId: item.agentId ?? "fictional-literal-writer",
          key: item.key, value: item.value, kind: "user_fact", scope: item.scope,
          taskId: item.taskId, sensitivity: item.sensitivity, userConfirmed: item.userConfirmed ?? true,
          idempotencyKey: `${scenario.spec.id}:${index}`,
        });
        // Manual Recall can include pending memories; the approved-only candidate judgment
        // applies to Context/Query and the explicit requireUserConfirmed reader below.
        const endpoints = scenario.spec.category === "security" ? ["context", "query"] as const : ["recall", "context", "query"] as const;
        for (const endpoint of endpoints) {
          const response = await service[endpoint]({ ...actor, query: scenario.spec.query });
          const selected = "memories" in response ? response.memories : "items" in response ? response.items : response.contextPack.items;
          expect(selected).toHaveLength(scenario.spec.expected.relevant.length);
          for (const item of selected) expect(item.value).toEqual(memory.value);
        }
        if (scenario.spec.category === "security") {
          const manual = await service.recall({ ...actor, query: scenario.spec.query });
          expect(manual.memories.map(item => item.key).sort()).toEqual(["fictional-note", "fictional-pending"]);
        }
        const result = await store.candidateReaders.full_text({ ...actor, query: scenario.spec.query, requireUserConfirmed: true });
        expect(result.lexicalIndexVersion).toBe("json-literal-values-v1");
      } finally { await service.close(); }
    });
  }
  it("publishes the actual projection capability and binds it into SQLite cursors", async () => {
    const store = new SqliteMemoryStore(":memory:"), service = new MemoryService(store);
    try {
      for (const key of ["fictional-a", "fictional-b"]) await service.remember({ ...actor, key, value: "fictional needle", kind: "user_fact", userConfirmed: true, idempotencyKey: key });
      const first = await service.recall({ ...actor, query: "needle", limit: 1 });
      expect(first.nextCursor).not.toBeNull();
      // Same physical reader, but a legacy wrapper cannot claim the new index generation.
      const legacy = new MemoryService({ appendRemember: store.appendRemember.bind(store), appendForget: store.appendForget.bind(store),
        recall: store.recall.bind(store), history: store.history.bind(store), candidateReaders: store.candidateReaders });
      await expect(legacy.recall({ ...actor, query: "needle", limit: 1, cursor: first.nextCursor! })).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
      expect(capabilitiesWithServiceSupport(developmentCapabilities(), service).retrieval.lexicalIndexVersion).toBe("json-literal-values-v1");
      const compatibility = new MemoryService(new InMemoryStore());
      expect(capabilitiesWithServiceSupport(developmentCapabilities(), compatibility).retrieval.lexicalIndexVersion).toBeNull();
      await compatibility.close(); await legacy.close();
    } finally { await service.close(); }
  });
});
