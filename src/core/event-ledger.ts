import { z } from "zod";
import { OpenContinuityError } from "../shared/errors.js";
import { memoryEventSchema, type MemoryEvent } from "../shared/types.js";

// One compatibility codec for JsonFileStore and explicit SQLite transfers.
const envelopeSchema = z.object({ schemaVersion: z.unknown().optional(), events: z.unknown().optional(), eventsV2: z.unknown().optional() });
export function decodeEventLedger(value: unknown): MemoryEvent[] {
  const envelope = envelopeSchema.parse(value);
  const raw = envelope.schemaVersion === 2 && envelope.events === undefined ? envelope.eventsV2
    : envelope.schemaVersion === undefined && envelope.eventsV2 === undefined ? envelope.events : undefined;
  if (!Array.isArray(raw)) throw new OpenContinuityError("VALIDATION_ERROR", "Unsupported or malformed event ledger", 400);
  const events = z.array(memoryEventSchema).parse(raw);
  if (envelope.schemaVersion !== 2 && events.some(event => event.fact)) {
    throw new OpenContinuityError("VALIDATION_ERROR", "Fact declarations require event ledger v2", 400);
  }
  return events;
}
export function encodeEventLedger(input: MemoryEvent[]) {
  const events = z.array(memoryEventSchema).parse(input);
  return events.some(event => event.fact) ? { schemaVersion: 2 as const, eventsV2: events } : { events };
}
