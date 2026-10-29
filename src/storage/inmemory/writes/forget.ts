import { randomUUID } from "node:crypto";
import type { MemoryReceiptLike } from "../../../core/memory/contracts.js";
import { storedMemoryIdentity } from "../../../core/memory/storage-contract.js";
import { OpenContinuityError } from "../../../shared/errors.js";
import { type MemoryEvent } from "../../../shared/types.js";
import type { InMemoryOperations } from "../contracts.js";
import { idempotencyKey, now } from "../identity.js";

export function forgetInMemory(context: InMemoryOperations, userId: string, agentId: string, memoryId: string, taskId?: string, includePrivate = false): MemoryReceiptLike {
  const current = Array.from(context.state.resolved.values()).find((memory) => memory.id === memoryId && context.belongsToUser(memory, userId) && context.isVisible(memory, agentId, taskId) && (includePrivate || memory.sensitivity !== "private"));
  if (!current) throw new OpenContinuityError("MEMORY_NOT_FOUND", "Memory not found", 404, { memoryId });
  const event: MemoryEvent = { id: randomUUID(), userId, agentId, type: "memory_forgotten", memoryId, key: current.key, kind: current.kind, scope: current.scope, taskId: current.taskId, sensitivity: current.sensitivity, userConfirmed: true, idempotencyKey: "forget:" + memoryId + ":" + randomUUID(), createdAt: now(), metadata: {}, memoryVersion: current.version };
  context.state.events.push(event); context.state.eventOwners.set(event.id, userId); context.state.resolved.delete(storedMemoryIdentity(userId, current));
  const receipt = { event, duplicate: false, current };
  context.state.idempotency.set(idempotencyKey(userId, event.idempotencyKey), receipt);
  return structuredClone(receipt);
}
