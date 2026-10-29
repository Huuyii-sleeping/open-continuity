import { type SQLInputValue } from "node:sqlite";
import { parseFactGroupRequest, type FactGroupRequest } from "../../../core/facts/contracts.js";
import type { SqliteRecordContext } from "../contracts.js";
import { scopeIdentity } from "../identity.js";
import { rowToMemory } from "../row-mapping.js";

export function factGroupSqlite(context: SqliteRecordContext, request: FactGroupRequest) {
  context.assertOpen();
  const input = parseFactGroupRequest(request);
  const values: SQLInputValue[] = [input.userId, input.scope, scopeIdentity(input), input.kind, input.group, Number(input.includePrivate)];
  const clauses = ["user_id = ?", "scope = ?", "scope_identity = ?", "kind = ?", "fact_group = ?", "(? = 1 OR sensitivity <> 'private')"];
  if (input.requireUserConfirmed) clauses.push("user_confirmed = 1");
  values.push(input.limit + 1);
  try {
    const rows = context.all(`SELECT * FROM memories_current WHERE ${clauses.join(" AND ")} ORDER BY updated_at DESC, id DESC LIMIT ?`, values);
    return { memories: rows.slice(0, input.limit).map(rowToMemory), truncated: rows.length > input.limit };
  } catch (error) { throw context.storageError(error); }
}
