import type { DatabaseSync } from "node:sqlite";

export const SQLITE_LEXICAL_INDEX_VERSION = "json-literal-values-v1" as const;

/** Search projection only. The authoritative JSON value/event is never rewritten. */
export function sqliteLexicalText(serialized: unknown): string {
  if (typeof serialized !== "string") throw new Error("Invalid lexical JSON input");
  const pending: unknown[] = [JSON.parse(serialized)], pieces: string[] = [];
  while (pending.length) {
    const value = pending.pop();
    if (typeof value === "string") pieces.push(value.replaceAll("\0", " "));
    else if (value === null || typeof value === "boolean" || typeof value === "number") pieces.push(String(value));
    else if (Array.isArray(value)) {
      for (let index = value.length - 1; index >= 0; index--) pending.push(value[index]);
    } else if (typeof value === "object") {
      const entries = Object.entries(value);
      for (let index = entries.length - 1; index >= 0; index--) {
        const [key, child] = entries[index]!; pending.push(child, key);
      }
    } else throw new Error("Invalid lexical JSON value");
  }
  return pieces.join("\n");
}

/** Every supported writer connection registers this deterministic, local SQL function. */
export function registerSqliteLexicalFunctions(database: DatabaseSync): void {
  database.function("open_continuity_lexical_text", { deterministic: true }, sqliteLexicalText);
}

/** Stable INTEGER PRIMARY KEY row IDs avoid relying on current-table implicit row IDs. */
export const sqliteLexicalIndexMigration: readonly string[] = [
  "DROP TRIGGER memories_current_fts_insert",
  "DROP TRIGGER memories_current_fts_update",
  "DROP TRIGGER memories_current_fts_delete",
  "CREATE TABLE memory_fts_keys (rowid INTEGER PRIMARY KEY, memory_id TEXT NOT NULL UNIQUE)",
  "DELETE FROM memories_fts",
  "INSERT INTO memory_fts_keys (memory_id) SELECT id FROM memories_current ORDER BY id",
  `INSERT INTO memories_fts (rowid, memory_id, memory_key, value_text)
    SELECT k.rowid, m.id, open_continuity_lexical_text(json_quote(m.memory_key)), open_continuity_lexical_text(m.value)
    FROM memories_current m JOIN memory_fts_keys k ON k.memory_id = m.id`,
  `CREATE TRIGGER memories_current_fts_insert AFTER INSERT ON memories_current BEGIN
    INSERT INTO memory_fts_keys (memory_id) VALUES (new.id);
    INSERT INTO memories_fts (rowid, memory_id, memory_key, value_text)
      SELECT rowid, new.id, open_continuity_lexical_text(json_quote(new.memory_key)), open_continuity_lexical_text(new.value)
      FROM memory_fts_keys WHERE memory_id = new.id;
  END`,
  `CREATE TRIGGER memories_current_fts_update AFTER UPDATE OF id, memory_key, value ON memories_current
    WHEN old.id IS NOT new.id OR old.memory_key IS NOT new.memory_key OR old.value IS NOT new.value BEGIN
    DELETE FROM memories_fts WHERE rowid = (SELECT rowid FROM memory_fts_keys WHERE memory_id = old.id);
    UPDATE memory_fts_keys SET memory_id = new.id WHERE memory_id = old.id;
    INSERT INTO memories_fts (rowid, memory_id, memory_key, value_text)
      SELECT rowid, new.id, open_continuity_lexical_text(json_quote(new.memory_key)), open_continuity_lexical_text(new.value)
      FROM memory_fts_keys WHERE memory_id = new.id;
  END`,
  `CREATE TRIGGER memories_current_fts_delete AFTER DELETE ON memories_current BEGIN
    DELETE FROM memories_fts WHERE rowid = (SELECT rowid FROM memory_fts_keys WHERE memory_id = old.id);
    DELETE FROM memory_fts_keys WHERE memory_id = old.id;
  END`,
];
