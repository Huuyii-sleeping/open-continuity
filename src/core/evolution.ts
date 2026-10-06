import { isDeepStrictEqual } from "node:util";
import { OpenContinuityError } from "../shared/errors.js";
import type { MemoryConfidence, MemoryEvolutionAction, MemoryEvolutionReceipt, ParsedRememberInput, ResolvedMemory } from "../shared/types.js";

function isJsonObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype;
}

function mergeJsonObjects(current: Record<string, unknown>, patch: Record<string, unknown>): Record<string, unknown> {
  const result: Record<string, unknown> = { ...current };
  for (const [key, value] of Object.entries(patch)) {
    result[key] = isJsonObject(result[key]) && isJsonObject(value) ? mergeJsonObjects(result[key], value) : value;
  }
  return result;
}

export interface EvolutionResolution {
  value: unknown; action: MemoryEvolutionAction; version: number; supersedes?: { eventId: string; version: number }; confidence?: MemoryConfidence;
}

export function resolveEvolution(previous: ResolvedMemory | undefined, input: ParsedRememberInput): EvolutionResolution {
  if (input.expectedVersion !== undefined) {
    const currentVersion = previous?.version ?? 0;
    if (currentVersion !== input.expectedVersion) {
      throw new OpenContinuityError("VERSION_CONFLICT", "Memory version does not match expectedVersion", 409, {
        expectedVersion: input.expectedVersion, currentVersion, memoryId: previous?.id, currentSourceEventId: previous?.sourceEventId,
      });
    }
  }

  let value = input.value;
  if (input.writeMode === "merge") {
    if (!isJsonObject(input.value) || (previous && !isJsonObject(previous.value))) {
      throw new OpenContinuityError("VALIDATION_ERROR", "writeMode=merge requires both current and input values to be JSON objects", 400);
    }
    value = previous ? mergeJsonObjects(previous.value as Record<string, unknown>, input.value) : input.value;
  }

  const action: MemoryEvolutionAction = previous ? (input.writeMode === "merge" ? "merged" : "replaced") : "created";
  return {
    value, action, version: (previous?.version ?? 0) + 1,
    supersedes: previous ? { eventId: previous.sourceEventId, version: previous.version } : undefined,
    confidence: input.confidence === undefined ? undefined : { score: input.confidence, basis: input.confidenceBasis! },
  };
}

export function evolutionReceipt(input: ParsedRememberInput, resolution: EvolutionResolution): MemoryEvolutionReceipt {
  return {
    action: resolution.action, version: resolution.version, writeMode: input.writeMode,
    concurrency: input.expectedVersion === undefined ? "last_write_wins" : "compare_and_set", supersedes: resolution.supersedes,
  };
}

export function evolutionReceiptFromEvent(event: { evolutionAction?: MemoryEvolutionAction; writeMode?: "replace" | "merge"; expectedVersion?: number; supersedes?: { eventId: string; version: number }; memoryVersion?: number }, current: ResolvedMemory): MemoryEvolutionReceipt {
  return {
    action: event.evolutionAction ?? (current.version === 1 ? "created" : "replaced"),
    version: event.memoryVersion ?? current.version,
    writeMode: event.writeMode ?? "replace",
    concurrency: event.expectedVersion === undefined ? "last_write_wins" : "compare_and_set",
    supersedes: event.supersedes ?? current.supersedes,
  };
}

export function sameEvolutionRequest(event: { inputValue?: unknown; value?: unknown; writeMode?: string; expectedVersion?: number; confidence?: MemoryConfidence }, input: ParsedRememberInput): boolean {
  const storedInput = event.inputValue === undefined ? event.value : event.inputValue;
  const confidence = input.confidence === undefined ? undefined : { score: input.confidence, basis: input.confidenceBasis! };
  return isDeepStrictEqual(storedInput, input.value) && (event.writeMode ?? "replace") === input.writeMode
    && event.expectedVersion === input.expectedVersion && isDeepStrictEqual(event.confidence, confidence);
}
