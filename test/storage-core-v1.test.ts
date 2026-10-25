import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { DataType, newDb } from "pg-mem";
import { afterEach } from "vitest";
import { MemoryService } from "../src/core/memory-service.js";
import { InMemoryStore, JsonFileStore, type MemoryStore } from "../src/core/memory-store.js";
import type { MemoryRepository } from "../src/core/storage-contract.js";
import { PostgresMemoryStore, type DatabasePool } from "../src/postgres/postgres-memory-store.js";
import { SqliteMemoryStore } from "../src/sqlite/sqlite-memory-store.js";
import { storageConformance } from "./helpers/storage-conformance.js";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0)) await cleanup(); });
for (const backend of ["inmemory", "json", "sqlite", "postgres-pg-mem"] as const) {
  storageConformance(backend, async () => {
    const root = mkdtempSync(join(tmpdir(), "open-continuity-storage-contract-"));
    let pool: DatabasePool | undefined;
    let store: MemoryStore & MemoryRepository;
    let reopenStore: () => MemoryStore;
    const source = resolve(process.env.OPEN_CONTINUITY_CONFORMANCE_SOURCE ?? ".");
    const memoryModule = await import(pathToFileURL(join(source, "src/core/memory-store.ts")).href) as { InMemoryStore: typeof InMemoryStore; JsonFileStore: typeof JsonFileStore };
    const serviceModule = await import(pathToFileURL(join(source, "src/core/memory-service.ts")).href) as { MemoryService: typeof MemoryService };
    if (backend === "inmemory") {
      const ledger = new memoryModule.InMemoryStore(); store = ledger;
      reopenStore = () => new memoryModule.InMemoryStore(ledger.allEvents());
    }
    else if (backend === "json") {
      reopenStore = () => new memoryModule.JsonFileStore(join(root, "fictional.json"));
      store = reopenStore() as MemoryStore & MemoryRepository;
    }
    else if (backend === "sqlite") {
      const module = await import(pathToFileURL(join(source, "src/sqlite/sqlite-memory-store.ts")).href) as { SqliteMemoryStore: typeof SqliteMemoryStore };
      reopenStore = () => new module.SqliteMemoryStore(join(root, "fictional.db"));
      store = reopenStore() as MemoryStore & MemoryRepository;
    }
    else {
      const database = newDb({ autoCreateForeignKeyIndices: true });
      database.public.registerFunction({ name: "pg_advisory_xact_lock", args: [DataType.integer], returns: DataType.integer, implementation: () => 1 });
      database.public.registerFunction({ name: "strpos", args: [DataType.text, DataType.text], returns: DataType.integer, implementation: (text: string, part: string) => text.indexOf(part) + 1 });
      const adapter = database.adapters.createPg(); pool = new adapter.Pool();
      const module = await import(pathToFileURL(join(source, "src/postgres/postgres-memory-store.ts")).href) as { PostgresMemoryStore: typeof PostgresMemoryStore };
      store = new module.PostgresMemoryStore(pool!);
      // Reopen an already migrated schema; pg-mem cannot reliably repeat ALTER DDL.
      reopenStore = () => new module.PostgresMemoryStore(pool!, { autoMigrate: false });
    }
    const service = new serviceModule.MemoryService(store);
    const instances = [service];
    cleanups.push(async () => { try { for (const instance of instances) await instance.close(); await pool?.end?.(); } finally { rmSync(root, { recursive: true, force: true }); } });
    return { store, service, reopen: async () => {
      await service.close();
      const reopened = new serviceModule.MemoryService(reopenStore());
      instances.push(reopened);
      return reopened;
    } };
  }, { pgMemReservedJsonKeys: backend === "postgres-pg-mem" });
}
