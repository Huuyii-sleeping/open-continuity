import { createHash } from "node:crypto";
import type { ContextPackItem, EvidenceCitation } from "../../shared/types.js";
import { jsonValueSchema } from "../../shared/types.js";
import { contextContractError } from "../context/coverage.js";
export function projection(item: ContextPackItem) {
  return {
    key: item.key, value: item.value, kind: item.kind, scope: item.scope, taskId: item.taskId,
    fact: item.fact, memoryId: item.memoryId, sourceEventId: item.sourceEventId, version: item.version, sourceAgentId: item.sourceAgentId
  };
}
export function citationFor(item: ContextPackItem): EvidenceCitation {
  if (!item.memoryId || !item.sourceEventId || !item.sourceAgentId || !Number.isInteger(item.version) || item.version < 1
    || !jsonValueSchema.safeParse(item.value).success) contextContractError();
  const contentHash = createHash("sha256").update(JSON.stringify(projection(item))).digest("hex");
  const id = "memory:" + createHash("sha256").update(JSON.stringify([item.memoryId, item.sourceEventId, item.version, contentHash])).digest("base64url");
  return {
    id, memoryId: item.memoryId, sourceEventId: item.sourceEventId, version: item.version,
    sourceAgentId: item.sourceAgentId, contentHash, hashModel: "sha256-json-projection-v1"
  };
}
