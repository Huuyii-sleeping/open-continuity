import type { SQLInputValue } from "node:sqlite";
import type { CandidateSearchInput } from "../../../core/retrieval/contracts.js";

/** Shared eligibility is composed into every channel before ordering and top-K. */
export function sqliteCandidateEligibility(input: CandidateSearchInput) {
  const values: SQLInputValue[] = [input.userId, input.agentId, input.taskId ?? null, input.taskId ?? null, Number(input.includePrivate)];
  const clauses = ["m.user_id = ?", "(m.scope = 'user' OR (m.scope = 'agent' AND m.owner_agent_id = ?) OR (m.scope = 'task' AND ? IS NOT NULL AND m.task_id = ?))", "(? = 1 OR m.sensitivity <> 'private')"];
  const add = (clause: string, value: SQLInputValue) => { clauses.push(clause); values.push(value); };
  if (input.scope) add("m.scope = ?", input.scope);
  if (input.kind) add("m.kind = ?", input.kind);
  if (input.key) add("m.memory_key = ?", input.key);
  if (input.requireUserConfirmed) clauses.push("m.user_confirmed = 1");
  return { clauses, values };
}
