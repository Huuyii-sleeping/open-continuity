import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DataType, newDb } from "pg-mem";
import { afterEach } from "vitest";
import { MemoryService } from "../../src/core/application/memory-service.js";
import { InMemoryStore } from "../../src/storage/inmemory/store.js";
import { JsonFileStore } from "../../src/storage/json/store.js";
import { SqliteMemoryStore } from "../../src/storage/sqlite/sqlite-memory-store.js";
import { PostgresMemoryStore, type DatabasePool } from "../../src/storage/postgres/postgres-memory-store.js";
import { handoffReviewConformance } from "../helpers/handoff-review-conformance.js";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0)) await cleanup(); });
for (const kind of ["inmemory", "json", "sqlite", "postgres-pg-mem"] as const) {
  handoffReviewConformance(kind, async () => {
    const root = mkdtempSync(join(tmpdir(), "oc-fictional-handoff-review-"));
    let backing: InMemoryStore | undefined, pool: DatabasePool | undefined, pgOpened = false;
    if (kind === "postgres-pg-mem") {
      const database = newDb({ autoCreateForeignKeyIndices: true });
      database.public.registerFunction({ name: "pg_advisory_xact_lock", args: [DataType.integer], returns: DataType.integer, implementation: () => 1 });
      const adapter = database.adapters.createPg(); pool = new adapter.Pool();
    }
    const open = () => {
      if (kind === "inmemory") { backing = new InMemoryStore(backing?.allEvents()); return new MemoryService(backing); }
      if (kind === "json") return new MemoryService(new JsonFileStore(join(root, "fictional.json")));
      if (kind === "sqlite") return new MemoryService(new SqliteMemoryStore(join(root, "fictional.db")));
      const s = new MemoryService(new PostgresMemoryStore(pool!, { autoMigrate: !pgOpened })); pgOpened = true; return s;
    };
    let service = open();
    cleanups.push(async () => { await service.closeGracefully(); await pool?.end?.(); rmSync(root, { recursive: true, force: true }); });
    return { service, reopen: async () => { await service.closeGracefully(); service = open(); return service; } };
  });
}
