import { chmodSync, copyFileSync, existsSync, mkdirSync, renameSync, rmSync, statSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { OpenContinuityError } from "../shared/errors.js";
import { LATEST_SQLITE_SCHEMA_VERSION } from "./schema.js";

export interface SqliteDatabaseStatus {
  ok: boolean;
  recognized: boolean;
  supportedSchema: boolean;
  databasePath: string;
  integrity: string[];
  schemaVersion: number;
  latestSchemaVersion: number;
  migrationRequired: boolean;
  memories: number;
  events: number;
}

export interface SqliteBackupResult {
  source: string;
  output: string;
  bytes: number;
  status: SqliteDatabaseStatus;
}

export interface SqliteRestoreResult {
  source: string;
  databasePath: string;
  status: SqliteDatabaseStatus;
}

function rows(database: DatabaseSync, sql: string): Array<Record<string, unknown>> {
  return database.prepare(sql).all() as Array<Record<string, unknown>>;
}

function scalar(database: DatabaseSync, sql: string): number {
  const row = database.prepare(sql).get() as Record<string, unknown> | undefined;
  return Number(row ? Object.values(row)[0] : 0);
}

function hasTable(database: DatabaseSync, table: string): boolean {
  return Boolean(database.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(table));
}

function quoteSqlString(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}

function assertDifferentPaths(left: string, right: string): void {
  if (resolve(left) === resolve(right)) throw new OpenContinuityError("VALIDATION_ERROR", "Source and destination database paths must differ", 400);
}

function assertHealthy(status: SqliteDatabaseStatus, label: string): void {
  if (!status.ok) throw new OpenContinuityError("STORAGE_ERROR", `${label} failed SQLite integrity_check`, 409, { integrity: status.integrity });
  if (!status.recognized) throw new OpenContinuityError("STORAGE_ERROR", `${label} is not an OpenContinuity database`, 409);
  if (!status.supportedSchema) throw new OpenContinuityError("STORAGE_ERROR", `${label} uses a newer unsupported schema`, 409, { schemaVersion: status.schemaVersion, latestSchemaVersion: status.latestSchemaVersion });
}

export function inspectSqliteDatabase(databasePath: string): SqliteDatabaseStatus {
  const path = resolve(databasePath);
  if (!existsSync(path)) throw new OpenContinuityError("STORAGE_ERROR", "SQLite database does not exist", 404, { databasePath: path });
  const database = new DatabaseSync(path, { readOnly: true });
  try {
    database.exec("PRAGMA busy_timeout = 5000");
    const integrity = rows(database, "PRAGMA integrity_check").map((row) => String(Object.values(row)[0]));
    const schemaVersion = hasTable(database, "open_continuity_schema_migrations")
      ? scalar(database, "SELECT COALESCE(MAX(version), 0) FROM open_continuity_schema_migrations") : 0;
    const memories = hasTable(database, "memories_current") ? scalar(database, "SELECT COUNT(*) FROM memories_current") : 0;
    const events = hasTable(database, "memory_events") ? scalar(database, "SELECT COUNT(*) FROM memory_events") : 0;
    const recognized = hasTable(database, "open_continuity_schema_migrations") && hasTable(database, "memories_current") && hasTable(database, "memory_events");
    return {
      ok: integrity.length === 1 && integrity[0] === "ok",
      recognized,
      supportedSchema: recognized && schemaVersion >= 1 && schemaVersion <= LATEST_SQLITE_SCHEMA_VERSION,
      databasePath: path,
      integrity,
      schemaVersion,
      latestSchemaVersion: LATEST_SQLITE_SCHEMA_VERSION,
      migrationRequired: schemaVersion < LATEST_SQLITE_SCHEMA_VERSION,
      memories,
      events,
    };
  } finally {
    database.close();
  }
}

export function backupSqliteDatabase(databasePath: string, outputPath: string): SqliteBackupResult {
  const source = resolve(databasePath);
  const output = resolve(outputPath);
  assertDifferentPaths(source, output);
  const sourceStatus = inspectSqliteDatabase(source);
  assertHealthy(sourceStatus, "Source database");
  if (existsSync(output)) throw new OpenContinuityError("STORAGE_ERROR", "Backup output already exists", 409, { output });
  mkdirSync(dirname(output), { recursive: true, mode: 0o700 });
  const temporary = `${output}.${process.pid}.tmp`;
  rmSync(temporary, { force: true });
  const database = new DatabaseSync(source);
  try {
    database.exec("PRAGMA busy_timeout = 5000");
    database.exec(`VACUUM main INTO ${quoteSqlString(temporary)}`);
  } finally {
    database.close();
  }
  try {
    const status = inspectSqliteDatabase(temporary);
    assertHealthy(status, "Backup database");
    renameSync(temporary, output);
    chmodSync(output, 0o600);
    const finalStatus = { ...status, databasePath: output };
    return { source, output, bytes: statSync(output).size, status: finalStatus };
  } catch (error) {
    rmSync(temporary, { force: true });
    throw error;
  }
}

export function restoreSqliteDatabase(backupPath: string, databasePath: string): SqliteRestoreResult {
  const source = resolve(backupPath);
  const target = resolve(databasePath);
  assertDifferentPaths(source, target);
  const sourceStatus = inspectSqliteDatabase(source);
  assertHealthy(sourceStatus, "Backup database");
  mkdirSync(dirname(target), { recursive: true, mode: 0o700 });
  if (existsSync(target)) throw new OpenContinuityError("STORAGE_ERROR", "Restore output already exists", 409, { databasePath: target });

  const temporary = `${target}.${process.pid}.restore.tmp`;
  rmSync(temporary, { force: true });
  copyFileSync(source, temporary);
  const stagedStatus = inspectSqliteDatabase(temporary);
  assertHealthy(stagedStatus, "Staged restore database");

  try {
    renameSync(temporary, target);
    chmodSync(target, 0o600);
    const status = inspectSqliteDatabase(target);
    assertHealthy(status, "Restored database");
    return { source, databasePath: target, status };
  } catch (error) {
    rmSync(temporary, { force: true });
    throw error;
  }
}
