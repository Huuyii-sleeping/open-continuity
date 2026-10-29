import { createHash } from "node:crypto";
import type { ParsedRecallInput } from "../../shared/types.js";

export function retrievalFingerprint(input: ParsedRecallInput): string {
  const scope = {
    userId: input.userId, agentId: input.agentId, query: input.query ?? "", key: input.key ?? null, kind: input.kind ?? null,
    scope: input.scope ?? null, taskId: input.taskId ?? null, includePrivate: input.includePrivate,
  };
  return createHash("sha256").update(JSON.stringify(scope)).digest("base64url");
}
