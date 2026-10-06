import type { QueryResult } from "pg";

export interface Queryable {
  query(text: string, values?: unknown[]): Promise<QueryResult>;
}

export const postgresSchemaStatements = [
  `CREATE TABLE IF NOT EXISTS open_continuity_schema_migrations (
    version INTEGER PRIMARY KEY,
    applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )`,
  `CREATE TABLE IF NOT EXISTS memories_current (
    id UUID PRIMARY KEY,
    user_id TEXT NOT NULL,
    memory_key TEXT NOT NULL,
    value JSONB NOT NULL,
    kind TEXT NOT NULL CHECK (kind IN ('user_preference', 'user_fact', 'task_state', 'decision')),
    scope TEXT NOT NULL CHECK (scope IN ('user', 'task', 'agent')),
    task_id TEXT,
    owner_agent_id TEXT,
    sensitivity TEXT NOT NULL CHECK (sensitivity IN ('public', 'private')),
    user_confirmed BOOLEAN NOT NULL,
    source_event_id UUID NOT NULL,
    source_agent_id TEXT NOT NULL,
    updated_at TIMESTAMPTZ NOT NULL,
    version INTEGER NOT NULL CHECK (version > 0),
    scope_identity TEXT NOT NULL,
    CONSTRAINT memories_current_scope_fields CHECK (
      (scope = 'user' AND task_id IS NULL AND owner_agent_id IS NULL AND scope_identity = '-') OR
      (scope = 'task' AND task_id IS NOT NULL AND owner_agent_id IS NULL AND scope_identity = task_id) OR
      (scope = 'agent' AND task_id IS NULL AND owner_agent_id IS NOT NULL AND scope_identity = owner_agent_id)
    ),
    CONSTRAINT memories_current_logical_key_unique UNIQUE (user_id, scope, scope_identity, memory_key)
  )`,
  `CREATE TABLE IF NOT EXISTS memory_events (
    id UUID PRIMARY KEY,
    user_id TEXT NOT NULL,
    agent_id TEXT NOT NULL,
    event_type TEXT NOT NULL CHECK (event_type IN ('memory_remembered', 'memory_forgotten')),
    memory_id UUID NOT NULL,
    memory_key TEXT NOT NULL,
    value JSONB,
    kind TEXT NOT NULL CHECK (kind IN ('user_preference', 'user_fact', 'task_state', 'decision')),
    scope TEXT NOT NULL CHECK (scope IN ('user', 'task', 'agent')),
    task_id TEXT,
    sensitivity TEXT NOT NULL CHECK (sensitivity IN ('public', 'private')),
    user_confirmed BOOLEAN NOT NULL,
    idempotency_key TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL,
    metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
    memory_version INTEGER NOT NULL CHECK (memory_version > 0),
    CONSTRAINT memory_events_scope_fields CHECK ((scope = 'task' AND task_id IS NOT NULL) OR (scope <> 'task' AND task_id IS NULL)),
    CONSTRAINT memory_events_idempotency_unique UNIQUE (user_id, idempotency_key)
  )`,
  "ALTER TABLE memories_current ADD COLUMN IF NOT EXISTS supersedes_event_id UUID",
  "ALTER TABLE memories_current ADD COLUMN IF NOT EXISTS supersedes_version INTEGER",
  "ALTER TABLE memories_current ADD COLUMN IF NOT EXISTS confidence DOUBLE PRECISION",
  "ALTER TABLE memories_current ADD COLUMN IF NOT EXISTS confidence_basis TEXT",
  "ALTER TABLE memory_events ADD COLUMN IF NOT EXISTS input_value JSONB",
  "ALTER TABLE memory_events ADD COLUMN IF NOT EXISTS evolution_action TEXT",
  "ALTER TABLE memory_events ADD COLUMN IF NOT EXISTS write_mode TEXT",
  "ALTER TABLE memory_events ADD COLUMN IF NOT EXISTS expected_version INTEGER",
  "ALTER TABLE memory_events ADD COLUMN IF NOT EXISTS supersedes_event_id UUID",
  "ALTER TABLE memory_events ADD COLUMN IF NOT EXISTS supersedes_version INTEGER",
  "ALTER TABLE memory_events ADD COLUMN IF NOT EXISTS confidence DOUBLE PRECISION",
  "ALTER TABLE memory_events ADD COLUMN IF NOT EXISTS confidence_basis TEXT",
  "CREATE INDEX IF NOT EXISTS memories_current_recall_idx ON memories_current (user_id, updated_at DESC, id DESC)",
  "CREATE INDEX IF NOT EXISTS memories_current_task_idx ON memories_current (user_id, task_id, updated_at DESC)",
  "CREATE INDEX IF NOT EXISTS memories_current_agent_idx ON memories_current (user_id, owner_agent_id, updated_at DESC)",
  "CREATE INDEX IF NOT EXISTS memory_events_history_idx ON memory_events (user_id, created_at DESC, id DESC)",
  "CREATE INDEX IF NOT EXISTS memory_events_memory_idx ON memory_events (user_id, memory_id, created_at DESC)",
];

export async function migratePostgres(client: Queryable): Promise<void> {
  await client.query("BEGIN");
  try {
    await client.query("SELECT pg_advisory_xact_lock($1)", [173535241]);
    for (const statement of postgresSchemaStatements) await client.query(statement);
    await client.query("INSERT INTO open_continuity_schema_migrations (version) VALUES ($1), ($2) ON CONFLICT (version) DO NOTHING", [1, 2]);
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  }
}
