import { homedir } from "node:os";
import { SqliteMemoryStore } from "../../storage/sqlite/sqlite-memory-store.js";

const databasePath = process.env.OPEN_CONTINUITY_SQLITE_PATH || homedir() + "/.open-continuity/memories.db";
const store = new SqliteMemoryStore(databasePath);
store.close();
process.stdout.write(`${JSON.stringify({ ok: true, databasePath })}\n`);
