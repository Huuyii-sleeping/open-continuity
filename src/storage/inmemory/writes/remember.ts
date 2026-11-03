import { randomUUID } from "node:crypto";
import type { MemoryReceiptLike } from "../../../core/memory/contracts.js";
import { evolutionReceipt, resolveEvolution } from "../../../core/memory/evolution.js";
import { memoryIdentity } from "../../../core/memory/storage-contract.js";
import { OpenContinuityError } from "../../../shared/errors.js";
import { type MemoryEvent, type ParsedRememberInput, type ResolvedMemory } from "../../../shared/types.js";
import type { InMemoryOperations } from "../contracts.js";
import { idempotencyKey, now } from "../identity.js";
import { sameRememberRequest } from "../request-equality.js";

export function rememberInMemory(context: InMemoryOperations, input: ParsedRememberInput): MemoryReceiptLike {
  input = structuredClone(input);
  const scopedIdempotencyKey = idempotencyKey(input.userId, input.idempotencyKey);
  const duplicate = context.state.idempotency.get(scopedIdempotencyKey);
  if (duplicate) {
    if (!sameRememberRequest(duplicate.event, input)) throw new OpenContinuityError("IDEMPOTENCY_CONFLICT", "Idempotency key was already used for a different request", 409, { idempotencyKey: input.idempotencyKey });
    return structuredClone({ ...duplicate, duplicate: true });
  }
  const mapKey = memoryIdentity(input);
  const previous = context.state.resolved.get(mapKey);
  const resolution = resolveEvolution(previous, input);
  const id = previous?.id || randomUUID();
  const event: MemoryEvent = { id: randomUUID(), userId: input.userId, agentId: input.agentId, type: "memory_remembered", memoryId: id, key: input.key, value: resolution.value, inputValue: input.value, kind: input.kind, scope: input.scope, taskId: input.taskId, sensitivity: input.sensitivity, userConfirmed: input.userConfirmed, idempotencyKey: input.idempotencyKey, createdAt: now(), metadata: input.metadata, memoryVersion: resolution.version, evolutionAction: resolution.action, writeMode: input.writeMode, expectedVersion: input.expectedVersion, supersedes: resolution.supersedes, confidence: resolution.confidence, fact: input.fact };
  const current: ResolvedMemory = { id, key: input.key, value: resolution.value, kind: input.kind, scope: input.scope, taskId: input.taskId, ownerAgentId: input.scope === "agent" ? input.agentId : undefined, sensitivity: input.sensitivity, userConfirmed: input.userConfirmed, sourceEventId: event.id, sourceAgentId: input.agentId, updatedAt: event.createdAt, version: resolution.version, supersedes: resolution.supersedes, confidence: resolution.confidence, fact: input.fact };
  context.state.events.push(event); context.state.resolved.set(mapKey, current);
  context.state.eventOwners.set(event.id, input.userId);
  const receipt = { event, duplicate: false, current, evolution: evolutionReceipt(input, resolution) }; context.state.idempotency.set(idempotencyKey(input.userId, input.idempotencyKey), receipt); return structuredClone(receipt);
}
