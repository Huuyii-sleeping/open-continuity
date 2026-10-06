import { OpenContinuityError } from "../shared/errors.js";
import { PostgresMemoryStore } from "../postgres/postgres-memory-store.js";
import { SqliteMemoryStore } from "../sqlite/sqlite-memory-store.js";
import { JsonFileStore, type MemoryStore } from "./memory-store.js";
import { capabilitiesForProfile, resolveRuntimeProfile, type RuntimeCapabilities, type RuntimeProfileConfig } from "./profile.js";

export type StorageKind = "json" | "sqlite" | "postgres";

export interface StoreRuntime {
  kind: StorageKind;
  store: MemoryStore;
  profile: RuntimeProfileConfig;
  capabilities: RuntimeCapabilities;
}

export async function createStoreFromEnv(env: NodeJS.ProcessEnv = process.env): Promise<StoreRuntime> {
  const profile = resolveRuntimeProfile(env);
  const kind = profile.storage;
  const runtime = (store: MemoryStore): StoreRuntime => ({ kind, store, profile, capabilities: capabilitiesForProfile(profile) });
  if (kind === "json") {
    return runtime(new JsonFileStore(env.OPEN_CONTINUITY_DATA_FILE));
  }
  if (kind === "sqlite") {
    return runtime(new SqliteMemoryStore(env.OPEN_CONTINUITY_SQLITE_PATH));
  }
  if (kind === "postgres") {
    const connectionString = env.OPEN_CONTINUITY_DATABASE_URL || env.DATABASE_URL;
    if (!connectionString) {
      throw new OpenContinuityError("CONFIGURATION_ERROR", "OPEN_CONTINUITY_DATABASE_URL or DATABASE_URL is required for PostgreSQL storage", 500);
    }
    const store = PostgresMemoryStore.fromConnectionString(connectionString, { autoMigrate: env.OPEN_CONTINUITY_AUTO_MIGRATE !== "false" });
    await store.initialize();
    return runtime(store);
  }
  throw new OpenContinuityError("CONFIGURATION_ERROR", "Unsupported storage kind", 500, { value: kind });
}
