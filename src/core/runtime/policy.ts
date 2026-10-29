import { z } from "zod";
import { OpenContinuityError } from "../../shared/errors.js";
const policySchema = z.object({
  defaultTimeoutMs: z.number().int().min(10).max(30000).default(1500),
  maxConcurrentRequests: z.number().int().min(1).max(256).default(16),
  maxPendingReads: z.number().int().min(1).max(256).default(8),
}).strict();
export type ReadRuntimePolicy = z.input<typeof policySchema>;
export function resolveReadRuntimePolicy(input: ReadRuntimePolicy) { const parsed = policySchema.safeParse(input); if (!parsed.success) throw new OpenContinuityError("VALIDATION_ERROR", "Invalid read runtime policy", 400); return Object.freeze(parsed.data); }
