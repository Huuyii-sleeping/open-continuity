import type { MemoryReceiptLike } from "../../../core/memory/contracts.js";
import { evolutionReceiptFromEvent } from "../../../core/memory/evolution.js";
import { OpenContinuityError } from "../../../shared/errors.js";
import type { ParsedRememberInput } from "../../../shared/types.js";
import type { PostgresRecordContext } from "../contracts.js";
import { eventSnapshot, rowToEvent } from "../event-mapping.js";
import { sameRequest } from "../request-equality.js";

export async function duplicatePostgres(context: PostgresRecordContext, input: ParsedRememberInput): Promise<MemoryReceiptLike> {
  const result = await context.query("SELECT * FROM memory_events WHERE user_id = $1 AND idempotency_key = $2", [input.userId, input.idempotencyKey]);
  const row = result.rows[0];
  if (!row || !sameRequest(row, input)) throw new OpenContinuityError("IDEMPOTENCY_CONFLICT", "Idempotency key was already used for a different request", 409, { idempotencyKey: input.idempotencyKey });
  const event = rowToEvent(row);
  const current = eventSnapshot(row);
  return { event, duplicate: true, current, evolution: evolutionReceiptFromEvent(event, current) };
}
