import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { DataType, newDb } from "pg-mem";
import type { MemoryStore } from "../../src/core/memory-store.js";
import type { MemoryService } from "../../src/core/memory-service.js";
import type { DatabasePool } from "../../src/postgres/postgres-memory-store.js";
import type { Backend } from "../baseline/evaluator.js";

export async function candidateRuntime(source: string, backend: Backend) {
  const directory = mkdtempSync(join(tmpdir(),"oc-candidate-eval-"));
  const load = (name: string) => import(pathToFileURL(join(source,name)).href);
  let pool: DatabasePool | undefined, service: MemoryService | undefined;
  try {
    let store: MemoryStore;
    if (backend === "sqlite") {
      const module = await load("src/sqlite/sqlite-memory-store.ts") as typeof import("../../src/sqlite/sqlite-memory-store.js");
      store = new module.SqliteMemoryStore(join(directory,"fictional.db"));
    } else if (backend === "postgres-pg-mem") {
      const db = newDb({ autoCreateForeignKeyIndices: true });
      db.public.registerFunction({ name: "pg_advisory_xact_lock", args: [DataType.integer], returns: DataType.integer, implementation: () => 1 });
      db.public.registerFunction({ name: "strpos", args: [DataType.text,DataType.text], returns: DataType.integer, implementation: (text: string,part: string) => text.indexOf(part)+1 });
      const adapter = db.adapters.createPg(); pool = new adapter.Pool();
      const module = await load("src/postgres/postgres-memory-store.ts") as typeof import("../../src/postgres/postgres-memory-store.js");
      store = new module.PostgresMemoryStore(pool!);
    } else {
      const module = await load("src/core/memory-store.ts") as typeof import("../../src/core/memory-store.js");
      store = backend === "json" ? new module.JsonFileStore(join(directory,"fictional.json")) : new module.InMemoryStore();
    }
    const module = await load("src/core/memory-service.ts") as typeof import("../../src/core/memory-service.js");
    service = new module.MemoryService(store);
    return { store,service,databasePath: join(directory,"fictional.db"),close: async () => {
      try { await service!.close(); } finally { try { await pool?.end?.(); } finally { rmSync(directory,{ recursive: true,force: true }); } }
    } };
  } catch(error) {
    try { await service?.close(); } finally { try { await pool?.end?.(); } finally { rmSync(directory,{ recursive: true,force: true }); } }
    throw error;
  }
}
