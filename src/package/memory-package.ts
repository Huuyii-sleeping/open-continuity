import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { z } from "zod";
import { OpenContinuityError } from "../shared/errors.js";
import { memoryEventSchema, type MemoryEvent } from "../shared/types.js";
import { SqliteMemoryStore } from "../sqlite/sqlite-memory-store.js";
import { OPEN_CONTINUITY_VERSION } from "../version.js";

const PACKAGE_VERSION = "1.0";
const manifestSchema = z.object({
  format: z.literal("open-continuity-memory-package"), version: z.literal(PACKAGE_VERSION),
  createdAt: z.iso.datetime({ offset: true }), source: z.object({ application: z.literal("open-continuity"), version: z.string() }),
  counts: z.object({ memories: z.number().int().min(0), events: z.number().int().min(0) }),
  files: z.object({ memories: z.literal("memories.jsonl"), events: z.literal("events.jsonl") }),
  checksums: z.object({ memoriesSha256: z.string().regex(/^[a-f0-9]{64}$/), eventsSha256: z.string().regex(/^[a-f0-9]{64}$/) }),
});

export interface MemoryPackageManifest extends z.infer<typeof manifestSchema> {}

function sha256(contents: string): string { return createHash("sha256").update(contents).digest("hex"); }
function jsonl(values: unknown[]): string { return values.map((value) => JSON.stringify(value)).join("\n") + (values.length ? "\n" : ""); }
function scopeIdentity(event: MemoryEvent): string { return event.scope === "task" ? event.taskId! : event.scope === "agent" ? event.agentId : "-"; }

export function materializeMemories(events: MemoryEvent[]): Array<Record<string, unknown>> {
  const current = new Map<string, Record<string, unknown>>();
  for (const event of events) {
    if (event.type === "memory_forgotten") {
      for (const [key, memory] of current) if (memory.id === event.memoryId && memory.userId === event.userId) current.delete(key);
      continue;
    }
    const key = [event.userId, event.scope, scopeIdentity(event), event.key].join(":");
    current.set(key, {
      id: event.memoryId, userId: event.userId, key: event.key, value: event.value, kind: event.kind, scope: event.scope,
      ...(event.taskId ? { taskId: event.taskId } : {}), ...(event.scope === "agent" ? { ownerAgentId: event.agentId } : {}),
      sensitivity: event.sensitivity, userConfirmed: event.userConfirmed, sourceEventId: event.id, sourceAgentId: event.agentId,
      updatedAt: event.createdAt, version: event.memoryVersion ?? 1, ...(event.supersedes ? { supersedes: event.supersedes } : {}),
      ...(event.confidence ? { confidence: event.confidence } : {}),
    });
  }
  return [...current.values()].sort((left, right) => String(left.id).localeCompare(String(right.id)));
}

export function exportMemoryPackage(databasePath: string, outputDirectory: string, options: { userId?: string } = {}): MemoryPackageManifest {
  const output = resolve(outputDirectory);
  if (existsSync(output) && readdirSync(output).length > 0) throw new OpenContinuityError("STORAGE_ERROR", "Memory Package output directory must be empty", 409, { output });
  const store = new SqliteMemoryStore(databasePath);
  let events: MemoryEvent[];
  try { events = store.exportEvents().filter((event) => !options.userId || event.userId === options.userId); } finally { store.close(); }
  const memories = materializeMemories(events);
  const memoriesContents = jsonl(memories);
  const eventsContents = jsonl(events);
  const temporary = join(dirname(output), `.${basename(output)}.${process.pid}.tmp`);
  rmSync(temporary, { recursive: true, force: true });
  mkdirSync(temporary, { recursive: true, mode: 0o700 });
  const manifest: MemoryPackageManifest = {
    format: "open-continuity-memory-package", version: PACKAGE_VERSION, createdAt: new Date().toISOString(),
    source: { application: "open-continuity", version: OPEN_CONTINUITY_VERSION }, counts: { memories: memories.length, events: events.length },
    files: { memories: "memories.jsonl", events: "events.jsonl" },
    checksums: { memoriesSha256: sha256(memoriesContents), eventsSha256: sha256(eventsContents) },
  };
  writeFileSync(join(temporary, "memories.jsonl"), memoriesContents, { encoding: "utf8", mode: 0o600 });
  writeFileSync(join(temporary, "events.jsonl"), eventsContents, { encoding: "utf8", mode: 0o600 });
  writeFileSync(join(temporary, "manifest.json"), JSON.stringify(manifest, null, 2) + "\n", { encoding: "utf8", mode: 0o600 });
  if (existsSync(output)) rmSync(output, { recursive: true });
  renameSync(temporary, output);
  return manifest;
}

function parseJsonLines(contents: string): unknown[] {
  return contents.split(/\r?\n/).filter(Boolean).map((line, index) => {
    try { return JSON.parse(line); } catch { throw new OpenContinuityError("VALIDATION_ERROR", "Invalid JSONL in Memory Package", 400, { line: index + 1 }); }
  });
}

export function importMemoryPackage(inputDirectory: string, databasePath: string, options: { targetUserId?: string } = {}): MemoryPackageManifest {
  const input = resolve(inputDirectory);
  const manifest = manifestSchema.parse(JSON.parse(readFileSync(join(input, "manifest.json"), "utf8")));
  const memoriesContents = readFileSync(join(input, manifest.files.memories), "utf8");
  const eventsContents = readFileSync(join(input, manifest.files.events), "utf8");
  if (sha256(memoriesContents) !== manifest.checksums.memoriesSha256 || sha256(eventsContents) !== manifest.checksums.eventsSha256) {
    throw new OpenContinuityError("VALIDATION_ERROR", "Memory Package checksum verification failed", 400);
  }
  const events = z.array(memoryEventSchema).parse(parseJsonLines(eventsContents));
  const memories = parseJsonLines(memoriesContents);
  if (events.length !== manifest.counts.events || memories.length !== manifest.counts.memories) {
    throw new OpenContinuityError("VALIDATION_ERROR", "Memory Package counts do not match the manifest", 400);
  }
  const materialized = materializeMemories(events);
  if (jsonl(materialized) !== memoriesContents) throw new OpenContinuityError("VALIDATION_ERROR", "Memory Package current memories do not match the event ledger", 400);
  const importedEvents = options.targetUserId ? events.map((event) => ({ ...event, userId: options.targetUserId! })) : events;
  const store = new SqliteMemoryStore(databasePath);
  try { store.importEvents(importedEvents); } finally { store.close(); }
  return manifest;
}
