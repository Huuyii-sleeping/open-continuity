import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { OpenContinuityError } from "../shared/errors.js";
import { memoryEventSchema, type MemoryEvent } from "../shared/types.js";
import { SqliteMemoryStore } from "./sqlite-memory-store.js";

const ledgerSchema = z.object({ events: z.array(memoryEventSchema) });

export function readJsonLedger(filePath: string): MemoryEvent[] {
  try {
    return ledgerSchema.parse(JSON.parse(readFileSync(filePath, "utf8"))).events;
  } catch (error) {
    if (error instanceof OpenContinuityError) throw error;
    throw new OpenContinuityError("VALIDATION_ERROR", "Unable to read a valid OpenContinuity JSON ledger", 400,
      error instanceof z.ZodError ? error.issues : undefined);
  }
}

export function writeJsonLedger(filePath: string, events: MemoryEvent[]): void {
  mkdirSync(dirname(filePath), { recursive: true });
  const temporaryPath = `${filePath}.${process.pid}.${randomUUID()}.tmp`;
  try {
    writeFileSync(temporaryPath, JSON.stringify({ events }, null, 2) + "\n", "utf8");
    renameSync(temporaryPath, filePath);
  } finally {
    if (existsSync(temporaryPath)) unlinkSync(temporaryPath);
  }
}

export function importJsonToSqlite(inputPath: string, databasePath: string): number {
  const events = readJsonLedger(inputPath);
  const store = new SqliteMemoryStore(databasePath);
  try { store.importEvents(events); } finally { store.close(); }
  return events.length;
}

export function exportSqliteToJson(databasePath: string, outputPath: string): number {
  const store = new SqliteMemoryStore(databasePath);
  try {
    const events = store.exportEvents();
    writeJsonLedger(outputPath, events);
    return events.length;
  } finally { store.close(); }
}
