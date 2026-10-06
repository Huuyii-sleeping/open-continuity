import type { DatabaseSync } from "node:sqlite";

const SQLITE_BUSY_RETRY_MS = 25;
const SQLITE_BUSY_TIMEOUT_MS = 10_000;

const migrations: ReadonlyArray<ReadonlyArray<string>> = [
  [
    `CREATE TABLE memories_current (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      memory_key TEXT NOT NULL,
      value TEXT NOT NULL,
      kind TEXT NOT NULL CHECK (kind IN ('user_preference', 'user_fact', 'task_state', 'decision')),
      scope TEXT NOT NULL CHECK (scope IN ('user', 'task', 'agent')),
      task_id TEXT,
      owner_agent_id TEXT,
      sensitivity TEXT NOT NULL CHECK (sensitivity IN ('public', 'private')),
      user_confirmed INTEGER NOT NULL CHECK (user_confirmed IN (0, 1)),
      source_event_id TEXT NOT NULL,
      source_agent_id TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      version INTEGER NOT NULL CHECK (version > 0),
      scope_identity TEXT NOT NULL,
      CONSTRAINT memories_current_scope_fields CHECK (
        (scope = 'user' AND task_id IS NULL AND owner_agent_id IS NULL AND scope_identity = '-') OR
        (scope = 'task' AND task_id IS NOT NULL AND owner_agent_id IS NULL AND scope_identity = task_id) OR
        (scope = 'agent' AND task_id IS NULL AND owner_agent_id IS NOT NULL AND scope_identity = owner_agent_id)
      ),
      CONSTRAINT memories_current_logical_key_unique UNIQUE (user_id, scope, scope_identity, memory_key)
    )`,
    `CREATE TABLE memory_events (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      agent_id TEXT NOT NULL,
      event_type TEXT NOT NULL CHECK (event_type IN ('memory_remembered', 'memory_forgotten')),
      memory_id TEXT NOT NULL,
      memory_key TEXT NOT NULL,
      value TEXT,
      kind TEXT NOT NULL CHECK (kind IN ('user_preference', 'user_fact', 'task_state', 'decision')),
      scope TEXT NOT NULL CHECK (scope IN ('user', 'task', 'agent')),
      task_id TEXT,
      sensitivity TEXT NOT NULL CHECK (sensitivity IN ('public', 'private')),
      user_confirmed INTEGER NOT NULL CHECK (user_confirmed IN (0, 1)),
      idempotency_key TEXT NOT NULL,
      created_at TEXT NOT NULL,
      metadata TEXT NOT NULL DEFAULT '{}',
      memory_version INTEGER NOT NULL CHECK (memory_version > 0),
      CONSTRAINT memory_events_scope_fields CHECK ((scope = 'task' AND task_id IS NOT NULL) OR (scope <> 'task' AND task_id IS NULL)),
      CONSTRAINT memory_events_idempotency_unique UNIQUE (user_id, idempotency_key)
    )`,
    "CREATE INDEX memories_current_recall_idx ON memories_current (user_id, updated_at DESC, id DESC)",
    "CREATE INDEX memories_current_task_idx ON memories_current (user_id, task_id, updated_at DESC)",
    "CREATE INDEX memories_current_agent_idx ON memories_current (user_id, owner_agent_id, updated_at DESC)",
    "CREATE INDEX memory_events_history_idx ON memory_events (user_id, created_at DESC, id DESC)",
    "CREATE INDEX memory_events_memory_idx ON memory_events (user_id, memory_id, created_at DESC, id DESC)",
  ],
  [
    "CREATE VIRTUAL TABLE memories_fts USING fts5(memory_id UNINDEXED, memory_key, value_text, tokenize='trigram')",
    `CREATE TRIGGER memories_current_fts_insert AFTER INSERT ON memories_current BEGIN
      INSERT INTO memories_fts (memory_id, memory_key, value_text) VALUES (new.id, new.memory_key, new.value);
    END`,
    `CREATE TRIGGER memories_current_fts_update AFTER UPDATE OF id, memory_key, value ON memories_current BEGIN
      DELETE FROM memories_fts WHERE memory_id = old.id;
      INSERT INTO memories_fts (memory_id, memory_key, value_text) VALUES (new.id, new.memory_key, new.value);
    END`,
    `CREATE TRIGGER memories_current_fts_delete AFTER DELETE ON memories_current BEGIN
      DELETE FROM memories_fts WHERE memory_id = old.id;
    END`,
    "INSERT INTO memories_fts (memory_id, memory_key, value_text) SELECT id, memory_key, value FROM memories_current",
  ],
  [
    "ALTER TABLE memories_current ADD COLUMN supersedes_event_id TEXT",
    "ALTER TABLE memories_current ADD COLUMN supersedes_version INTEGER",
    "ALTER TABLE memories_current ADD COLUMN confidence REAL",
    "ALTER TABLE memories_current ADD COLUMN confidence_basis TEXT",
    "ALTER TABLE memory_events ADD COLUMN input_value TEXT",
    "ALTER TABLE memory_events ADD COLUMN evolution_action TEXT",
    "ALTER TABLE memory_events ADD COLUMN write_mode TEXT",
    "ALTER TABLE memory_events ADD COLUMN expected_version INTEGER",
    "ALTER TABLE memory_events ADD COLUMN supersedes_event_id TEXT",
    "ALTER TABLE memory_events ADD COLUMN supersedes_version INTEGER",
    "ALTER TABLE memory_events ADD COLUMN confidence REAL",
    "ALTER TABLE memory_events ADD COLUMN confidence_basis TEXT",
  ],
];

export const LATEST_SQLITE_SCHEMA_VERSION = migrations.length;

function isBusyError(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const code = "code" in error ? error.code : undefined;
  return code === "SQLITE_BUSY" || code === "SQLITE_LOCKED" || ("message" in error && typeof error.message === "string" && /busy|locked/i.test(error.message));
}

function withBusyRetry<T>(operation: () => T): T {
  const startedAt = Date.now();
  while (true) {
    try {
      return operation();
    } catch (error) {
      if (!isBusyError(error) || Date.now() - startedAt >= SQLITE_BUSY_TIMEOUT_MS) throw error;
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, SQLITE_BUSY_RETRY_MS);
    }
  }
}

export function configureSqlite(database: DatabaseSync): void {
  database.exec("PRAGMA busy_timeout = 5000");
  withBusyRetry(() => database.exec("PRAGMA journal_mode = WAL"));
  database.exec("PRAGMA synchronous = NORMAL");
  database.exec("PRAGMA foreign_keys = ON");
}

export function migrateSqlite(database: DatabaseSync): void {
  withBusyRetry(() => {
    database.exec("BEGIN IMMEDIATE");
    try {
      database.exec(`CREATE TABLE IF NOT EXISTS open_continuity_schema_migrations (
        version INTEGER PRIMARY KEY,
        applied_at TEXT NOT NULL
      )`);
      const applied = new Set(
        database.prepare("SELECT version FROM open_continuity_schema_migrations").all()
          .map((row) => Number(row.version)),
      );
      migrations.forEach((statements, index) => {
        const version = index + 1;
        if (applied.has(version)) return;
        for (const statement of statements) database.exec(statement);
        database.prepare("INSERT INTO open_continuity_schema_migrations (version, applied_at) VALUES (?, ?)")
          .run(version, new Date().toISOString());
      });
      database.exec("COMMIT");
    } catch (error) {
      if (database.isTransaction) database.exec("ROLLBACK");
      throw error;
    }
  });
}
