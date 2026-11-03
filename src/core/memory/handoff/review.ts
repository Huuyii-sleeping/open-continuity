import { createHash, randomUUID } from "node:crypto";
import { z } from "zod";
import { handoffCreateInputSchema, recallInputSchema, type ParsedHandoffCreateInput } from "../../../shared/types.js";
import { OpenContinuityError } from "../../../shared/errors.js";
import type { RecallReader } from "../../retrieval/contracts.js";
import { HANDOFF_REVIEW_METADATA, HANDOFF_REVIEW_VERSION, type HandoffDraft, type HandoffSnapshot, type HandoffWriteReview } from "./contracts.js";

export const handoffPrepareInputSchema = z.object({
  ...handoffCreateInputSchema.shape,
  sensitivity: z.enum(["public", "private"]).default("private"),
  idempotencyKey: z.string().min(1).optional(),
  includePrivate: z.boolean().default(false),
}).superRefine((input, context) => {
  if (input.expiresAt && Date.parse(input.expiresAt) <= Date.now()) context.addIssue({ code: "custom", path: ["expiresAt"], message: "expiresAt must be in the future" });
});
export type HandoffPrepareInput = z.input<typeof handoffPrepareInputSchema>;
export const handoffSnapshotSchema = z.object({ memoryId: z.string().min(1).nullable(), sourceEventId: z.string().min(1).nullable(), version: z.number().int().min(0) }).strict()
  .refine(value => value.version === 0 ? value.memoryId === null && value.sourceEventId === null : value.memoryId !== null && value.sourceEventId !== null, "Invalid handoff snapshot");
export const handoffDraftSchema = z.object({
  version: z.literal(HANDOFF_REVIEW_VERSION), draftId: z.uuid(), preparedAt: z.iso.datetime({ offset: true }), reviewExpiresAt: z.iso.datetime({ offset: true }),
  input: handoffCreateInputSchema, expectedSnapshot: handoffSnapshotSchema, fingerprint: z.string().regex(/^[a-f0-9]{64}$/),
}).strict();
export const handoffConfirmInputSchema = z.object({
  userId: z.string().min(1), agentId: z.string().min(1), draft: handoffDraftSchema,
  reviewedFingerprint: z.string().regex(/^[a-f0-9]{64}$/), userConfirmed: z.literal(true),
});
export type HandoffConfirmInput = z.input<typeof handoffConfirmInputSchema>;

function canonical(value: unknown): string {
  if (Array.isArray(value)) return "[" + value.map(canonical).join(",") + "]";
  if (value && typeof value === "object") return "{" + Object.keys(value).sort().filter(key => (value as Record<string, unknown>)[key] !== undefined)
    .map(key => JSON.stringify(key) + ":" + canonical((value as Record<string, unknown>)[key])).join(",") + "}";
  const encoded = JSON.stringify(value);
  if (encoded === undefined) throw new OpenContinuityError("VALIDATION_ERROR", "Handoff draft must contain JSON values", 400);
  return encoded;
}
export function handoffDraftFingerprint(draft: Omit<HandoffDraft, "fingerprint">): string {
  const text = canonical(draft);
  if (Buffer.byteLength(text) > 256 * 1024 - 128) throw new OpenContinuityError("VALIDATION_ERROR", "Handoff draft exceeds the review size limit", 400);
  return createHash("sha256").update(text).digest("hex");
}
export function validateHandoffDraft(value: unknown): HandoffDraft {
  const draft = structuredClone(handoffDraftSchema.parse(value));
  const { fingerprint, ...payload } = draft;
  if (draft.input.metadata[HANDOFF_REVIEW_METADATA] !== undefined
    || (draft.input.metadata.openContinuityType !== undefined && draft.input.metadata.openContinuityType !== "handoff_capsule")
    || draft.input.expectedVersion !== draft.expectedSnapshot.version
    || fingerprint !== handoffDraftFingerprint(payload) || Date.parse(draft.reviewExpiresAt) !== Date.parse(draft.preparedAt) + 86400000
    || Date.parse(draft.preparedAt) > Date.now() + 300000 || Date.parse(draft.reviewExpiresAt) <= Date.now())
    throw new OpenContinuityError("VALIDATION_ERROR", "Handoff draft changed or review expired; prepare and review it again", 400);
  return draft;
}
/** Read only: task information is supplied by the caller, never invented or harvested from Agent history. */
export async function prepareHandoffRecord(value: z.output<typeof handoffPrepareInputSchema>, reader: RecallReader): Promise<HandoffDraft> {
  value = structuredClone(value);
  if (value.metadata[HANDOFF_REVIEW_METADATA] !== undefined || (value.metadata.openContinuityType !== undefined && value.metadata.openContinuityType !== "handoff_capsule"))
    throw new OpenContinuityError("VALIDATION_ERROR", "Reserved handoff review metadata", 400);
  const result = await reader.recall(recallInputSchema.parse({ userId: value.userId, agentId: value.agentId, taskId: value.taskId,
    key: `handoff:${value.taskId}`, scope: "task", includePrivate: value.includePrivate, limit: 1 }));
  const current = result.memories[0];
  const expectedSnapshot: HandoffSnapshot = { memoryId: current?.id ?? null, sourceEventId: current?.sourceEventId ?? null, version: current?.version ?? 0 };
  if (value.expectedVersion !== undefined && value.expectedVersion !== expectedSnapshot.version) throw new OpenContinuityError("VERSION_CONFLICT", "Handoff changed; prepare it again", 409);
  const draftId = randomUUID(), preparedAt = new Date().toISOString();
  const { includePrivate: _includePrivate, ...content } = value;
  const input = handoffCreateInputSchema.parse({ ...content, expectedVersion: expectedSnapshot.version, idempotencyKey: value.idempotencyKey ?? `handoff-review:${draftId}` });
  const payload = { version: HANDOFF_REVIEW_VERSION, draftId, preparedAt, reviewExpiresAt: new Date(Date.parse(preparedAt) + 86400000).toISOString(), input, expectedSnapshot };
  return { ...payload, fingerprint: handoffDraftFingerprint(payload) };
}
/** Confirmation binds actor, exact reviewed contents and the target snapshot. Store owns the atomic guard. */
export function confirmedHandoffInput(input: HandoffConfirmInput): ParsedHandoffCreateInput {
  const value = handoffConfirmInputSchema.parse(input), draft = validateHandoffDraft(value.draft);
  if (draft.input.userId !== value.userId || draft.input.agentId !== value.agentId) throw new OpenContinuityError("FORBIDDEN", "Handoff draft belongs to a different actor", 403);
  if (draft.fingerprint !== value.reviewedFingerprint) throw new OpenContinuityError("VALIDATION_ERROR", "Confirm the exact reviewed handoff fingerprint", 400);
  const review: HandoffWriteReview = { version: HANDOFF_REVIEW_VERSION, draftFingerprint: draft.fingerprint,
    userId: value.userId, agentId: value.agentId, taskId: draft.input.taskId, expectedSnapshot: draft.expectedSnapshot };
  return { ...draft.input, metadata: { ...draft.input.metadata, [HANDOFF_REVIEW_METADATA]: review } };
}
