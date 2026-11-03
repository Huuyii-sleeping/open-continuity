import { evolutionReceiptFromEvent } from "../../../core/memory/evolution.js";
import { memoryIdentity, storedMemoryIdentity } from "../../../core/memory/storage-contract.js";
import { OpenContinuityError } from "../../../shared/errors.js";
import { type MemoryEvent, type ResolvedMemory } from "../../../shared/types.js";
import type { InMemoryOperations } from "../contracts.js";
import { idempotencyKey } from "../identity.js";

export function replayInMemoryEvent(context: InMemoryOperations, event: MemoryEvent): void {
  if (context.state.eventOwners.has(event.id) || context.state.idempotency.has(idempotencyKey(event.userId, event.idempotencyKey))) {
    throw new OpenContinuityError("STORAGE_ERROR", "Duplicate event identity in memory ledger", 500);
  }
  context.state.events.push(event);
  context.state.eventOwners.set(event.id, event.userId);
  if (event.type === "memory_forgotten") {
    const current = Array.from(context.state.resolved.values()).find((memory) => memory.id === event.memoryId && context.belongsToUser(memory, event.userId));
    if (!current) throw new OpenContinuityError("STORAGE_ERROR", "Forgotten memory has no current state in ledger", 500);
    context.state.resolved.delete(storedMemoryIdentity(event.userId, current));
    context.state.idempotency.set(idempotencyKey(event.userId, event.idempotencyKey), { event, duplicate: false, current });
    return;
  }
  const mapKey = memoryIdentity(event);
  const previous = context.state.resolved.get(mapKey);
  const current: ResolvedMemory = {
    id: event.memoryId, key: event.key, value: event.value, kind: event.kind, scope: event.scope, taskId: event.taskId, ownerAgentId: event.scope === "agent" ? event.agentId : undefined,
    sensitivity: event.sensitivity, userConfirmed: event.userConfirmed, sourceEventId: event.id, sourceAgentId: event.agentId,
    updatedAt: event.createdAt, version: event.memoryVersion ?? (previous?.version || 0) + 1, supersedes: event.supersedes, confidence: event.confidence, fact: event.fact,
  };
  context.state.resolved.set(mapKey, current);
  context.state.idempotency.set(idempotencyKey(event.userId, event.idempotencyKey), { event, duplicate: false, current, evolution: evolutionReceiptFromEvent(event, current) });
}
