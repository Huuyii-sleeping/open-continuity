import { mkdtempSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createStoreFromEnv } from "../src/core/store-factory.js";
import { JsonFileStore } from "../src/core/memory-store.js";
import { SqliteMemoryStore } from "../src/sqlite/sqlite-memory-store.js";
import { resolveRuntimeProfile } from "../src/core/profile.js";

describe("store factory", () => {
  const temporaryDirectories: string[] = [];
  afterEach(() => { for (const directory of temporaryDirectories.splice(0)) rmSync(directory, { recursive: true, force: true }); });

  function temporaryPath(name: string): string {
    const directory = mkdtempSync(join(homedir(), ".open-continuity-factory-test-"));
    temporaryDirectories.push(directory);
    return join(directory, name);
  }

  it("uses SQLite storage by default", async () => {
    const runtime = await createStoreFromEnv({ OPEN_CONTINUITY_SQLITE_PATH: temporaryPath("memories.db") });
    expect(runtime.kind).toBe("sqlite");
    expect(runtime.profile).toMatchObject({ name: "lite", storage: "sqlite", compatibilityMode: null, retrieval: { candidateLimit: 50 }, contextPack: { defaultTokenBudget: 1024, maxTokenBudget: 4096, maxMemories: 20 }, agenticQuery: { defaultMaxSteps: 3, maxSteps: 4, maxSubqueries: 3 } });
    expect(runtime.capabilities).toMatchObject({ profile: "lite", storage: "sqlite", retrieval: { fullTextEngine: "fts5", semantic: false, agentic: true }, contextPack: { enabled: true, maxTokenBudget: 4096, overflow: "omit_whole_memory" }, agenticQuery: { enabled: true, planner: "deterministic_v1", maxSteps: 4, maxSubqueries: 3, historyLimit: 50, semanticPlanner: false } });
    expect(runtime.store).toBeInstanceOf(SqliteMemoryStore);
    await runtime.store.close?.();
  });

  it("keeps JSON storage as an explicit compatibility mode", async () => {
    const runtime = await createStoreFromEnv({ OPEN_CONTINUITY_STORE: "json", OPEN_CONTINUITY_DATA_FILE: temporaryPath("memories.json") });
    expect(runtime.kind).toBe("json");
    expect(runtime.profile).toMatchObject({ name: "lite", storage: "json", compatibilityMode: "json_legacy" });
    expect(runtime.store).toBeInstanceOf(JsonFileStore);
  });

  it("rejects PostgreSQL mode without a connection string", async () => {
    await expect(createStoreFromEnv({ OPEN_CONTINUITY_STORE: "postgres" })).rejects.toMatchObject({ code: "CONFIGURATION_ERROR" });
  });

  it("rejects an unknown storage mode", async () => {
    await expect(createStoreFromEnv({ OPEN_CONTINUITY_STORE: "redis" })).rejects.toMatchObject({ code: "CONFIGURATION_ERROR" });
  });

  it("resolves Team defaults and preserves legacy PostgreSQL inference", () => {
    expect(resolveRuntimeProfile({ OPEN_CONTINUITY_PROFILE: "team" })).toMatchObject({ name: "team", storage: "postgres", retrieval: { candidateLimit: 100 }, contextPack: { defaultTokenBudget: 4096, maxTokenBudget: 16384, maxMemories: 50 }, agenticQuery: { defaultMaxSteps: 5, maxSteps: 8, maxSubqueries: 8 } });
    expect(resolveRuntimeProfile({ OPEN_CONTINUITY_STORE: "postgres" })).toMatchObject({ name: "team", storage: "postgres" });
  });

  it("rejects profile/storage conflicts and unimplemented Enterprise", () => {
    expect(() => resolveRuntimeProfile({ OPEN_CONTINUITY_PROFILE: "team", OPEN_CONTINUITY_STORE: "sqlite" })).toThrow("Team profile requires PostgreSQL storage");
    expect(() => resolveRuntimeProfile({ OPEN_CONTINUITY_PROFILE: "lite", OPEN_CONTINUITY_STORE: "postgres" })).toThrow("Lite profile supports SQLite or legacy JSON storage");
    expect(() => resolveRuntimeProfile({ OPEN_CONTINUITY_PROFILE: "enterprise" })).toThrow("Enterprise profile is not implemented yet");
    expect(() => resolveRuntimeProfile({ OPEN_CONTINUITY_PROFILE: "unknown" })).toThrow("OPEN_CONTINUITY_PROFILE must be lite, team, or enterprise");
  });
});
