import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { DataType, newDb } from "pg-mem";
import { expect, it } from "vitest";
import { MemoryService } from "../../src/core/application/memory-service.js";
import type { MemoryStore } from "../../src/core/memory/contracts.js";
import { InMemoryStore } from "../../src/storage/inmemory/store.js";
import { JsonFileStore } from "../../src/storage/json/store.js";
import { SqliteMemoryStore } from "../../src/storage/sqlite/sqlite-memory-store.js";
import { PostgresMemoryStore } from "../../src/storage/postgres/postgres-memory-store.js";
import { denseActor } from "../helpers/dense-fixture.js";

it.each(["inmemory", "json", "sqlite", "postgres"])("%s default capabilities do not silently promise Dense support", async backend => {
  const directory = mkdtempSync(join(tmpdir(), "oc-fictional-dense-capability-"));
  let store: MemoryStore;
  if (backend === "inmemory") store = new InMemoryStore();
  else if (backend === "json") store = new JsonFileStore(join(directory, "test.json"));
  else if (backend === "sqlite") store = new SqliteMemoryStore(join(directory, "test.db"));
  else { const database = newDb();
    database.public.registerFunction({ name: "pg_advisory_xact_lock", args: [DataType.integer], returns: DataType.integer, implementation: () => 1 });
    const Pool = database.adapters.createPg().Pool; const postgres = new PostgresMemoryStore(new Pool()); await postgres.initialize(); store = postgres; }
  const service = new MemoryService(store);
  try {
    expect(Object.keys(store.candidateReaders ?? {})).toEqual(["exact", "structured", "full_text"]);
    expect(service.retrievalCapabilityPolicy().experimentalDense).toBeNull();
    await expect(Promise.resolve().then(() => store.searchCandidates!({ ...denseActor, channel: "dense" }))).rejects.toThrow();
    await expect(service.synchronizeDenseIndex(denseActor)).rejects.toThrow(/not configured/);
    if (backend === "sqlite") { const db = new DatabaseSync(join(directory, "test.db"));
      expect(db.prepare("SELECT count(*) AS n FROM sqlite_master WHERE name LIKE 'memory_dense_%'").get()!.n).toBe(0); db.close(); }
  } finally { await service.close(); rmSync(directory, { recursive: true, force: true }); }
});
