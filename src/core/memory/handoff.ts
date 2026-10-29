import { recallInputSchema, storedHandoffCapsuleSchema, type HandoffCapsule, type handoffCreateInputSchema, type handoffResumeInputSchema, type RememberInput } from "../../shared/types.js";
import type { RecallReader } from "../retrieval/contracts.js";
import type { MemoryReceiptLike } from "./contracts.js";
export async function createHandoffRecord(value: ReturnType<typeof handoffCreateInputSchema.parse>, remember: (input: RememberInput) => Promise<MemoryReceiptLike>) {
  const storedCapsule = {
    schemaVersion: "1.0" as const, taskId: value.taskId, summary: value.summary, status: value.status,
    decisions: value.decisions, nextActions: value.nextActions, artifacts: value.artifacts, blockedBy: value.blockedBy,
    sourceAgentId: value.agentId, ...(value.expiresAt ? { expiresAt: value.expiresAt } : {}),
  };
  const memory = await remember({
    userId: value.userId, agentId: value.agentId, key: `handoff:${value.taskId}`, value: storedCapsule,
    kind: "task_state", scope: "task", taskId: value.taskId, sensitivity: value.sensitivity,
    userConfirmed: true, idempotencyKey: value.idempotencyKey, metadata: { ...value.metadata, openContinuityType: "handoff_capsule" },
  });
  const capsule: HandoffCapsule = { ...storedCapsule, createdAt: memory.event.createdAt };
  return { capsule, memory };

}
export async function resumeHandoffRecord(value: ReturnType<typeof handoffResumeInputSchema.parse>, reader: RecallReader) {
  const result = await reader.recall(recallInputSchema.parse({ ...value, key: `handoff:${value.taskId}`, scope: "task", limit: 1 }));
  const memory = result.memories[0] ?? null;
  if (!memory) return { capsule: null, memory: null, status: "not_found" as const };
  const storedCapsule = storedHandoffCapsuleSchema.parse(memory.value);
  const capsule: HandoffCapsule = { ...storedCapsule, createdAt: memory.updatedAt };
  if (capsule.expiresAt && Date.parse(capsule.expiresAt) <= Date.now()) {
    return { capsule: null, memory: null, status: "expired" as const };
  }
  return { capsule, memory, status: "ready" as const };

}
