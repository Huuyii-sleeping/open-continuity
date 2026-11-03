import { z } from "zod";
import { OpenContinuityError } from "../../../shared/errors.js";
import type { ParsedRememberInput, ResolvedMemory } from "../../../shared/types.js";
import { HANDOFF_REVIEW_METADATA, HANDOFF_REVIEW_VERSION } from "./contracts.js";

const snapshot = z.object({ memoryId: z.string().min(1).nullable(), sourceEventId: z.string().min(1).nullable(), version: z.number().int().min(0) }).strict();
const reviewSchema = z.object({ version: z.literal(HANDOFF_REVIEW_VERSION), draftFingerprint: z.string().regex(/^[a-f0-9]{64}$/),
  userId: z.string().min(1), agentId: z.string().min(1), taskId: z.string().min(1), expectedSnapshot: snapshot }).strict();
/** Invoked inside each built-in Store's existing write transaction/lock, before current/event mutation. */
export function guardReviewedHandoff(previous: ResolvedMemory | undefined, input: ParsedRememberInput): void {
  const raw = input.metadata[HANDOFF_REVIEW_METADATA];
  if (raw === undefined) return;
  const review = reviewSchema.parse(raw), expected = review.expectedSnapshot;
  if (input.kind !== "task_state" || input.scope !== "task" || input.key !== `handoff:${input.taskId}` || !input.userConfirmed
    || input.expectedVersion !== expected.version || input.userId !== review.userId || input.agentId !== review.agentId || input.taskId !== review.taskId
    || (expected.version === 0 ? expected.memoryId !== null || expected.sourceEventId !== null : expected.memoryId === null || expected.sourceEventId === null))
    throw new OpenContinuityError("VALIDATION_ERROR", "Invalid reviewed handoff write", 400);
  if ((previous?.id ?? null) !== expected.memoryId || (previous?.sourceEventId ?? null) !== expected.sourceEventId || (previous?.version ?? 0) !== expected.version)
    throw new OpenContinuityError("VERSION_CONFLICT", "Handoff changed after review; prepare and confirm a new draft", 409);
}
