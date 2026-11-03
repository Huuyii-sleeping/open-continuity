import { OpenContinuityError } from "../../shared/errors.js";
import type { ParsedRecallInput } from "../../shared/types.js";
import type { CandidateSearchResult } from "./contracts.js";
export function validateCandidateEligibility(batches: CandidateSearchResult[], input: ParsedRecallInput, requireUserConfirmed: boolean): void {
  for (const batch of batches) for (const { memory } of batch.hits) {
    if ((!input.includePrivate && memory.sensitivity === "private") || (requireUserConfirmed && !memory.userConfirmed)
      || (memory.scope === "agent" && memory.ownerAgentId !== input.agentId) || (memory.scope === "task" && memory.taskId !== input.taskId)
      || (input.key && memory.key !== input.key) || (input.kind && memory.kind !== input.kind) || (input.scope && memory.scope !== input.scope)) {
      throw new OpenContinuityError("STORAGE_ERROR", "Candidate eligibility contract violated", 500);
    }
  }
}
