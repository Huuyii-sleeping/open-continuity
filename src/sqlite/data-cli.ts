import { homedir } from "node:os";
import { resolve } from "node:path";
import { errorResponse, OpenContinuityError } from "../shared/errors.js";
import { exportSqliteToJson, importJsonToSqlite } from "./transfer.js";

function flag(name: string): string | undefined {
  const index = process.argv.indexOf(`--${name}`);
  if (index >= 0) return process.argv[index + 1];
  return process.argv.find((value) => value.startsWith(`--${name}=`))?.slice(name.length + 3);
}

const action = process.argv[2];
const databasePath = resolve(flag("database") || process.env.OPEN_CONTINUITY_SQLITE_PATH || homedir() + "/.open-continuity/memories.db");

try {
  if (action === "import-json") {
    const inputPath = resolve(flag("input") || process.env.OPEN_CONTINUITY_DATA_FILE || homedir() + "/.open-continuity/memories.json");
    const events = importJsonToSqlite(inputPath, databasePath);
    process.stdout.write(`${JSON.stringify({ ok: true, operation: action, events, inputPath, databasePath })}\n`);
  } else if (action === "export-json") {
    const outputPath = resolve(flag("output") || "./open-continuity-export.json");
    const events = exportSqliteToJson(databasePath, outputPath);
    process.stdout.write(`${JSON.stringify({ ok: true, operation: action, events, databasePath, outputPath })}\n`);
  } else {
    throw new OpenContinuityError("VALIDATION_ERROR", "Usage: npm run data:import-json -- --input <ledger.json> --database <memories.db> | npm run data:export-json -- --database <memories.db> --output <ledger.json>", 400);
  }
} catch (error) {
  console.error(JSON.stringify(errorResponse(error)));
  process.exitCode = 1;
}
