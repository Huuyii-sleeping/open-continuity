import { createHash, randomUUID } from "node:crypto";
import type { MemoryReceiptLike } from "../../../core/memory/contracts.js";
import { evolutionReceiptFromEvent, resolveEvolution } from "../../../core/memory/evolution.js";
import { memoryIdentity } from "../../../core/memory/storage-contract.js";
import { OpenContinuityError } from "../../../shared/errors.js";
import type { ParsedRememberInput } from "../../../shared/types.js";
import type { PostgresRememberPort } from "../contracts.js";
import { eventSnapshot, rowToEvent } from "../event-mapping.js";
import { scopeIdentity } from "../identity.js";
import { sameRequest } from "../request-equality.js";
import { rowToMemory } from "../row-mapping.js";

export async function rememberPostgres(context: PostgresRememberPort, input: ParsedRememberInput): Promise<MemoryReceiptLike> {
  input = structuredClone(input);
  await context.initialize();
  const client = await context.connect();
  let discard = false;
  try {
    await client.query("BEGIN");
    // Disjoint negative/positive lock key spaces; collisions only serialize unrelated writes.
    // Always acquire request identity before logical memory identity.
    const idemLock = -(createHash("sha256").update(JSON.stringify([input.userId, input.idempotencyKey])).digest().readUInt32BE(0) & 0x7fffffff) - 1;
    const memoryLock = createHash("sha256").update(memoryIdentity(input)).digest().readUInt32BE(0) & 0x7fffffff;
    await client.query("SELECT pg_advisory_xact_lock($1)", [idemLock]);
    await client.query("SELECT pg_advisory_xact_lock($1)", [memoryLock]);
    const existing = await client.query("SELECT * FROM memory_events WHERE user_id = $1 AND idempotency_key = $2", [input.userId, input.idempotencyKey]);
    if (existing.rows[0]) {
      if (!sameRequest(existing.rows[0], input)) throw new OpenContinuityError("IDEMPOTENCY_CONFLICT", "Idempotency key was already used for a different request", 409, { idempotencyKey: input.idempotencyKey });
      await client.query("COMMIT");
      const event = rowToEvent(existing.rows[0]);
      const current = eventSnapshot(existing.rows[0]);
      return { event, duplicate: true, current, evolution: evolutionReceiptFromEvent(event, current) };
    }

    const eventId = randomUUID();
    const candidateMemoryId = randomUUID();
    const identity = scopeIdentity(input);
    const previousResult = await client.query(
      "SELECT * FROM memories_current WHERE user_id = $1 AND scope = $2 AND scope_identity = $3 AND memory_key = $4 FOR UPDATE",
      [input.userId, input.scope, identity, input.key],
    );
    const resolution = resolveEvolution(previousResult.rows[0] ? rowToMemory(previousResult.rows[0]) : undefined, input);
    const timestamp = new Date().toISOString();
    const currentResult = input.expectedVersion !== undefined && previousResult.rows[0]
      ? await client.query(
        `UPDATE memories_current SET value = $1::jsonb, kind = $2, task_id = $3, owner_agent_id = $4, sensitivity = $5, user_confirmed = $6,
             source_event_id = $7, source_agent_id = $8, updated_at = $9, version = version + 1, supersedes_event_id = $10,
             supersedes_version = $11, confidence = $12, confidence_basis = $13
           WHERE user_id = $14 AND scope = $15 AND scope_identity = $16 AND memory_key = $17 AND version = $18 RETURNING *`,
        [JSON.stringify(resolution.value ?? null), input.kind, input.taskId ?? null, input.scope === "agent" ? input.agentId : null, input.sensitivity, input.userConfirmed, eventId, input.agentId, timestamp, resolution.supersedes?.eventId ?? null, resolution.supersedes?.version ?? null, resolution.confidence?.score ?? null, resolution.confidence?.basis ?? null, input.userId, input.scope, identity, input.key, input.expectedVersion],
      )
      : await client.query(
        `INSERT INTO memories_current (id, user_id, memory_key, value, kind, scope, task_id, owner_agent_id, sensitivity, user_confirmed, source_event_id, source_agent_id, updated_at, version, scope_identity, supersedes_event_id, supersedes_version, confidence, confidence_basis)
           VALUES ($1, $2, $3, $4::jsonb, $5, $6, $7, $8, $9, $10, $11, $12, $13, 1, $14, $15, $16, $17, $18)
           ON CONFLICT (user_id, scope, scope_identity, memory_key) DO UPDATE SET
             value = EXCLUDED.value, kind = EXCLUDED.kind, task_id = EXCLUDED.task_id, owner_agent_id = EXCLUDED.owner_agent_id,
             sensitivity = EXCLUDED.sensitivity, user_confirmed = EXCLUDED.user_confirmed, source_event_id = EXCLUDED.source_event_id,
             source_agent_id = EXCLUDED.source_agent_id, updated_at = EXCLUDED.updated_at, version = memories_current.version + 1,
             supersedes_event_id = EXCLUDED.supersedes_event_id, supersedes_version = EXCLUDED.supersedes_version,
             confidence = EXCLUDED.confidence, confidence_basis = EXCLUDED.confidence_basis
           WHERE ($19::integer IS NULL OR memories_current.version = $19)
           RETURNING *`,
        [candidateMemoryId, input.userId, input.key, JSON.stringify(resolution.value ?? null), input.kind, input.scope, input.taskId ?? null, input.scope === "agent" ? input.agentId : null, input.sensitivity, input.userConfirmed, eventId, input.agentId, timestamp, identity, resolution.supersedes?.eventId ?? null, resolution.supersedes?.version ?? null, resolution.confidence?.score ?? null, resolution.confidence?.basis ?? null, input.expectedVersion ?? null],
      );
    if (!currentResult.rows[0]) {
      const latest = await client.query(
        "SELECT id, version, source_event_id FROM memories_current WHERE user_id = $1 AND scope = $2 AND scope_identity = $3 AND memory_key = $4",
        [input.userId, input.scope, identity, input.key],
      );
      throw new OpenContinuityError("VERSION_CONFLICT", "Memory version does not match expectedVersion", 409, {
        expectedVersion: input.expectedVersion, currentVersion: latest.rows[0]?.version ?? 0, memoryId: latest.rows[0]?.id, currentSourceEventId: latest.rows[0]?.source_event_id,
      });
    }
    const current = rowToMemory(currentResult.rows[0]);
    const actualAction = current.version === 1 ? "created" : input.writeMode === "merge" ? "merged" : "replaced";
    const eventResult = await client.query(
      `INSERT INTO memory_events (id, user_id, agent_id, event_type, memory_id, memory_key, value, kind, scope, task_id, sensitivity, user_confirmed, idempotency_key, created_at, metadata, memory_version, input_value, evolution_action, write_mode, expected_version, supersedes_event_id, supersedes_version, confidence, confidence_basis)
         VALUES ($1, $2, $3, 'memory_remembered', $4, $5, $6::jsonb, $7, $8, $9, $10, $11, $12, $13, $14::jsonb, $15, $16::jsonb, $17, $18, $19, $20, $21, $22, $23) RETURNING *`,
      [eventId, input.userId, input.agentId, current.id, input.key, JSON.stringify(current.value), input.kind, input.scope, input.taskId ?? null, input.sensitivity, input.userConfirmed, input.idempotencyKey, timestamp, JSON.stringify(input.metadata), current.version, JSON.stringify(input.value ?? null), actualAction, input.writeMode, input.expectedVersion ?? null, current.supersedes?.eventId ?? null, current.supersedes?.version ?? null, resolution.confidence?.score ?? null, resolution.confidence?.basis ?? null],
    );
    if (input.fact || previousResult.rows[0]?.fact != null) {
      const fact = input.fact ? JSON.stringify(input.fact) : null;
      await client.query("UPDATE memories_current SET fact = $1::jsonb, fact_group = $2 WHERE id = $3", [fact, input.fact?.group ?? null, current.id]);
      await client.query("UPDATE memory_events SET fact = $1::jsonb WHERE id = $2", [fact, eventId]);
      if (input.fact) current.fact = input.fact;
      else delete current.fact;
    }
    await client.query("COMMIT");
    const event = rowToEvent(eventResult.rows[0]);
    if (input.fact) event.fact = input.fact;
    return { event, duplicate: false, current, evolution: evolutionReceiptFromEvent(event, current) };
  } catch (error) {
    if (!await context.rollback(client)) {
      discard = true;
      throw new OpenContinuityError("STORAGE_ERROR", "PostgreSQL transaction recovery failed", 500);
    }
    if (error instanceof OpenContinuityError) throw error;
    if (context.isUniqueViolation(error)) return context.readDuplicate(input);
    throw context.storageError(error);
  } finally { client.release(discard ? true : undefined); }
}
