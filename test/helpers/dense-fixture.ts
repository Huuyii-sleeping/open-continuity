import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SqliteMemoryStore } from "../../src/storage/sqlite/sqlite-memory-store.js";
import { MemoryService } from "../../src/core/application/memory-service.js";
import { DenseRetriever, type DenseExperimentOptions } from "../../src/core/retrieval/dense/retriever.js";
import type { EmbeddingProvider, EmbeddingSession } from "../../src/core/retrieval/dense/index-contracts.js";

export const denseActor = { userId: "fictional-dense-user", agentId: "fictional-reader", taskId: "fictional-task" };
export const denseModel = { fingerprint: "a".repeat(64), dimensions: 2, textVersion: "memory-value-v1" as const };
export const denseAdmission = { version: "dense-admission-v1" as const, modelFingerprint: denseModel.fingerprint, minScore: .62, minMargin: .14, minimumCandidates: 2 };
export function denseFixture(options: Partial<DenseExperimentOptions> = {}, embed?: EmbeddingSession["embed"]) {
  const directory = mkdtempSync(join(tmpdir(), "oc-fictional-dense-"));
  const path = join(directory, "test.db"), store = new SqliteMemoryStore(path);
  const index = store.enableDenseIndex(denseModel);
  const calls = { load: 0, run: 0, close: 0 };
  const provider: EmbeddingProvider = { model: denseModel, load: async () => { calls.load++;
    return { model: denseModel, embed: async (texts, mode) => { calls.run++; return embed ? embed(texts, mode) : texts.map(text => text.includes("unrelated") ? [0, 1] : [1, 0]); }, close: async () => { calls.close++; } };
  } };
  const dense = new DenseRetriever(index, provider, { admission: denseAdmission, ...options });
  const service = new MemoryService(store, { experimentalDense: dense });
  let counter = 0;
  const remember = (value: string, extra: Record<string, unknown> = {}) => service.remember({ userId: denseActor.userId, agentId: denseActor.agentId, key: `fictional-${counter}`, value,
    kind: "user_fact", sensitivity: "public", userConfirmed: true, idempotencyKey: `fictional-event-${counter++}`, ...extra });
  return { directory, path, store, index, dense, service, provider, calls, remember, cleanup: async () => { await service.closeGracefully(); rmSync(directory, { recursive: true, force: true }); } };
}
