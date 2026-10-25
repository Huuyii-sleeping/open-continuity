import { z } from "zod";
import { OpenContinuityError } from "../shared/errors.js";
import { memoryKindSchema, memoryScopeSchema, type ResolvedMemory } from "../shared/types.js";

const factGroupRequestSchema = z.object({
  userId: z.string().min(1), agentId: z.string().min(1), group: z.string().min(1).max(128),
  scope: memoryScopeSchema, taskId: z.string().min(1).optional(), kind: memoryKindSchema,
  includePrivate: z.boolean().default(false),
  requireUserConfirmed: z.boolean().default(false), limit: z.number().int().min(1).max(100).default(100),
}).strict().superRefine((input, context) => {
  if (input.scope === "task" && !input.taskId) context.addIssue({ code: "custom", path: ["taskId"], message: "task scope requires taskId" });
});
export type FactGroupRequest = z.input<typeof factGroupRequestSchema>;
export interface FactGroupResult { memories: ResolvedMemory[]; truncated: boolean; }
export interface FactGroupStore { readFactGroup(input: FactGroupRequest): FactGroupResult | Promise<FactGroupResult>; }
export function parseFactGroupRequest(input: FactGroupRequest) {
  const parsed = factGroupRequestSchema.safeParse(input);
  if (!parsed.success) throw new OpenContinuityError("VALIDATION_ERROR", "Invalid fact group request", 400);
  return parsed.data;
}
/** Permission is applied by the Store before this exact partition/structured filter. */
export function matchesFactGroup(memory: ResolvedMemory, input: ReturnType<typeof parseFactGroupRequest>): boolean {
  return memory.fact?.group === input.group && memory.scope === input.scope && memory.kind === input.kind
    && (memory.scope !== "task" || memory.taskId === input.taskId)
    && (memory.scope !== "agent" || memory.ownerAgentId === input.agentId)
    && (input.includePrivate || memory.sensitivity !== "private")
    && (!input.requireUserConfirmed || memory.userConfirmed);
}
