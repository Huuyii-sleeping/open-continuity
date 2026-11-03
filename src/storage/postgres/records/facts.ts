import { parseFactGroupRequest, type FactGroupRequest } from "../../../core/facts/contracts.js";
import type { PostgresRecordContext } from "../contracts.js";
import { scopeIdentity } from "../identity.js";
import { rowToMemory } from "../row-mapping.js";

export async function factGroupPostgres(context: PostgresRecordContext, request: FactGroupRequest) {
  const input = parseFactGroupRequest(request);
  await context.initialize();
  const values: unknown[] = [input.userId, input.scope, scopeIdentity(input), input.kind, input.group, input.includePrivate];
  const clauses = ["user_id = $1", "scope = $2", "scope_identity = $3", "kind = $4", "fact_group = $5", "($6::boolean OR sensitivity <> 'private')"];
  if (input.requireUserConfirmed) clauses.push("user_confirmed = TRUE");
  values.push(input.limit + 1);
  const result = await context.query(`SELECT * FROM memories_current WHERE ${clauses.join(" AND ")} ORDER BY updated_at DESC, id DESC LIMIT $${values.length}`, values);
  return { memories: result.rows.slice(0, input.limit).map(rowToMemory), truncated: result.rows.length > input.limit };
}
