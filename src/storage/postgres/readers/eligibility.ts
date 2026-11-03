import type { CandidateSearchInput } from "../../../core/retrieval/contracts.js";

export function postgresCandidateEligibility(input: CandidateSearchInput) {
  const values: unknown[] = [input.userId, input.agentId, input.taskId ?? null, input.includePrivate];
  const clauses = ["user_id = $1", "(scope = 'user' OR (scope = 'agent' AND owner_agent_id = $2) OR (scope = 'task' AND $3::text IS NOT NULL AND task_id = $3))", "($4::boolean OR sensitivity <> 'private')"];
  const add = (clause: string, value: unknown) => { values.push(value); clauses.push(clause.replace("?", "$" + values.length)); };
  if (input.scope) add("scope = ?", input.scope);
  if (input.kind) add("kind = ?", input.kind);
  if (input.key) add("memory_key = ?", input.key);
  if (input.requireUserConfirmed) clauses.push("user_confirmed = TRUE");
  return { values, clauses };
}
