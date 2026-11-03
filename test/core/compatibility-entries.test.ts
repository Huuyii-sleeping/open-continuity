import { expect, it } from "vitest";
import { MemoryService as LegacyService } from "../../src/core/memory-service.js";
import { MemoryService } from "../../src/core/application/memory-service.js";
import { RetrievalPipeline as LegacyPipeline } from "../../src/core/retrieval.js";
import { RetrievalPipeline } from "../../src/core/retrieval/pipeline.js";
import { CandidateRetrieval as LegacyCandidates } from "../../src/core/candidate-search.js";
import { CandidateRetrieval } from "../../src/core/retrieval/candidates.js";
import { InMemoryStore as LegacyMemory, JsonFileStore as LegacyJson } from "../../src/core/memory-store.js";
import { InMemoryStore } from "../../src/storage/inmemory/store.js";
import { JsonFileStore } from "../../src/storage/json/store.js";
import { SqliteMemoryStore as LegacySqlite } from "../../src/sqlite/sqlite-memory-store.js";
import { SqliteMemoryStore } from "../../src/storage/sqlite/sqlite-memory-store.js";
import { PostgresMemoryStore as LegacyPostgres } from "../../src/postgres/postgres-memory-store.js";
import { PostgresMemoryStore } from "../../src/storage/postgres/postgres-memory-store.js";
import { capabilitiesWithServiceSupport as LegacyCapabilities } from "../../src/core/profile.js";
import { capabilitiesWithServiceSupport } from "../../src/core/application/capabilities.js";

it("legacy entry points expose identical constructors and capability composition", () => {
  for (const [legacy, canonical] of [
    [LegacyService, MemoryService], [LegacyPipeline, RetrievalPipeline],
    [LegacyCandidates, CandidateRetrieval], [LegacyMemory, InMemoryStore],
    [LegacyJson, JsonFileStore], [LegacySqlite, SqliteMemoryStore],
    [LegacyPostgres, PostgresMemoryStore], [LegacyCapabilities, capabilitiesWithServiceSupport],
  ]) expect(legacy).toBe(canonical);
});
