import { existsSync } from "node:fs";
import { join } from "node:path";

/** Required responsibility -> implementation -> test mappings. This is not line/branch coverage. */
export interface RegisteredCoreContract { responsibility: string; implementation: string; test: string; level: "unit" | "backend_contract" | "integration"; }
const unit = (responsibility: string, implementation: string, test: string): RegisteredCoreContract => ({ responsibility, implementation, test, level: "unit" });
const backend = (responsibility: string, implementation: string, test: string): RegisteredCoreContract => ({ responsibility, implementation, test, level: "backend_contract" });
export const registeredCoreContracts: readonly RegisteredCoreContract[] = [
  { responsibility: "memory/handoff-review", implementation: "src/core/memory/handoff/review.ts", test: "test/core/memory/handoff-review.test.ts", level: "integration" },
  { responsibility: "memory/handoff-render", implementation: "src/core/memory/handoff/render.ts", test: "test/core/memory/handoff-render.test.ts", level: "integration" },
  { responsibility: "application/handoff-cli", implementation: "src/cli/handoff.ts", test: "test/handoff-cli.test.ts", level: "integration" },
  { responsibility: "application/handoff-process-workflow", implementation: "src/mcp/server.ts", test: "test/handoff-workflow.test.ts", level: "integration" },
  { responsibility: "memory/handoff-atomic-guard", implementation: "src/core/memory/handoff/write-guard.ts", test: "test/storage/handoff-review-storage.test.ts", level: "backend_contract" },
  unit("retrieval/relevance-model", "src/core/retrieval/reranking/local-reranker.ts", "test/core/retrieval/relevance-reranker.test.ts"),
  unit("retrieval/relevance-order", "src/core/retrieval/dense/reranking/order.ts", "test/core/retrieval/reranking-order.test.ts"),
  { responsibility: "retrieval/dense-reranking", implementation: "src/core/retrieval/dense/reranking/selection.ts", test: "test/core/retrieval/dense-reranking.test.ts", level: "integration" },
  { responsibility: "retrieval/dense-bidirectional-rescue", implementation: "src/core/retrieval/dense/rescue.ts", test: "test/core/retrieval/dense-rescue.test.ts", level: "integration" },
  backend("storage-sqlite/lexical-derived-index", "src/storage/sqlite/lexical-index.ts", "test/storage/sqlite-lexical-index.test.ts"),
  { responsibility: "retrieval/literal-values", implementation: "src/storage/sqlite/readers/full-text.ts", test: "test/core/retrieval/literal-values.test.ts", level: "integration" },
  { responsibility: "retrieval/dense-projection-cache", implementation: "src/core/retrieval/dense/ranker.ts", test: "test/core/retrieval/dense-snapshot-cache.test.ts", level: "integration" },
  { responsibility: "retrieval/dense-model-veto", implementation: "src/core/retrieval/dense/local-pair-verifier.ts", test: "test/core/retrieval/dense-local-verifier.test.ts", level: "integration" },
  { responsibility: "retrieval/dense-optimizer-parity", implementation: "src/core/retrieval/dense/ranker.ts", test: "test/core/retrieval/dense-optimizer-parity.test.ts", level: "integration" },
  { responsibility: "retrieval/dense-experimental-pipeline", implementation: "src/core/retrieval/dense/retriever.ts", test: "test/core/retrieval/dense-integration.test.ts", level: "integration" },
  backend("storage-sqlite/dense-derived-index", "src/storage/sqlite/dense-index.ts", "test/storage/sqlite-dense-index.test.ts"),
  unit("retrieval/dense-admission-staged", "src/core/retrieval/dense/admission.ts", "test/core/retrieval/dense-admission.test.ts"),
  unit("retrieval/dense-pair-verification-staged", "src/core/retrieval/dense/pair-verification.ts", "test/core/retrieval/dense-pair-verification.test.ts"),
  unit("runtime/local-model-owner-staged", "src/core/runtime/model-owner.ts", "test/core/runtime/model-owner.test.ts"),
  unit("runtime/model-artifacts-staged", "src/core/runtime/model-artifacts.ts", "test/core/runtime/model-artifacts.test.ts"),
  unit("context/selection-eligibility", "src/core/context/selection/eligibility.ts", "test/core/context/selection-eligibility.test.ts"),
  unit("context/selection-signals", "src/core/context/selection/signals.ts", "test/core/context/selection-signals.test.ts"),
  unit("context/selection-relevance", "src/core/context/selection/relevance.ts", "test/core/context/selection-relevance.test.ts"),
  unit("context/selection-input-order", "src/core/context/selection/input-order.ts", "test/core/context/selection-input-order.test.ts"),
  unit("context/selection-legacy", "src/core/context/selection/legacy.ts", "test/core/context/selection-legacy.test.ts"),
  unit("context/rendering", "src/core/context/rendering.ts", "test/core/context/rendering.test.ts"),
  unit("context/packing-budget", "src/core/context/packing/budget.ts", "test/core/context/packing-budget.test.ts"),
  unit("context/packing-coverage", "src/core/context/packing/coverage.ts", "test/core/context/packing-coverage.test.ts"),
  unit("context/packing-rank", "src/core/context/packing/rank.ts", "test/core/context/packing-rank.test.ts"),
  unit("runtime/deadline", "src/core/runtime/deadline.ts", "test/core/runtime/deadline.test.ts"),
  unit("runtime/policy", "src/core/runtime/policy.ts", "test/core/runtime/policy.test.ts"),
  unit("runtime/observer", "src/core/runtime/observer.ts", "test/core/runtime/observer.test.ts"),
  unit("runtime/store-guard", "src/core/runtime/store-guard.ts", "test/core/runtime/store-guard.test.ts"),
  unit("query/planner", "src/core/query/planner.ts", "test/core/query/planner.test.ts"),
  unit("query/recall", "src/core/query/recall.ts", "test/core/query/recall.test.ts"),
  unit("query/history", "src/core/query/history.ts", "test/core/query/history.test.ts"),
  unit("query/evidence", "src/core/query/evidence.ts", "test/core/query/evidence.test.ts"),
  unit("query/fact-review", "src/core/query/fact-review.ts", "test/core/query/fact-review.test.ts"),
  unit("query/response", "src/core/query/response.ts", "test/core/query/response.test.ts"),
  unit("query/sufficiency", "src/core/query/sufficiency.ts", "test/core/query/sufficiency.test.ts"),
  unit("query/budgeted-sufficiency", "src/core/query/budgeted-sufficiency.ts", "test/core/query/budgeted-sufficiency.test.ts"),
  unit("query/fallback", "src/core/query/fallback.ts", "test/core/query/fallback.test.ts"),
  unit("facts/validity", "src/core/facts/validity.ts", "test/core/facts/validity.test.ts"),
  unit("facts/references", "src/core/facts/references.ts", "test/core/facts/references.test.ts"),
  unit("facts/group-reader", "src/core/facts/group-reader.ts", "test/core/facts/group-reader.test.ts"),
  unit("facts/adjudication", "src/core/facts/adjudication.ts", "test/core/facts/adjudication.test.ts"),
  unit("answer/citations", "src/core/answer/citations.ts", "test/core/answer/citations.test.ts"),
  unit("answer/validation", "src/core/answer/validation.ts", "test/core/answer/validation.test.ts"),
  unit("answer/statements", "src/core/answer/statements.ts", "test/core/answer/statements.test.ts"),
  unit("memory/merge", "src/core/memory/merge.ts", "test/core/memory/merge.test.ts"),
  unit("memory/evolution", "src/core/memory/evolution.ts", "test/core/memory/evolution.test.ts"),
  unit("pagination/records", "src/core/pagination/records.ts", "test/core/pagination/records.test.ts"),
  unit("pagination/retrieval", "src/core/pagination/retrieval.ts", "test/core/pagination/retrieval.test.ts"),
  backend("storage-sqlite/list", "src/storage/sqlite/records/list.ts", "test/storage/sqlite-list-port.test.ts"),
  backend("storage-sqlite/facts", "src/storage/sqlite/records/facts.ts", "test/storage/sqlite-facts-port.test.ts"),
  backend("storage-sqlite/remember", "src/storage/sqlite/writes/remember.ts", "test/storage/sqlite-remember.test.ts"),
  backend("storage-sqlite/forget", "src/storage/sqlite/writes/forget.ts", "test/storage/sqlite-operations-write.test.ts"),
  backend("storage-sqlite/history", "src/storage/sqlite/records/history.ts", "test/storage/sqlite-operations-read.test.ts"),
  backend("storage-sqlite/import", "src/storage/sqlite/transfer/import-events.ts", "test/storage/sqlite-import-port.test.ts"),
  backend("storage-postgres/exact", "src/storage/postgres/readers/exact.ts", "test/storage/postgres-exact-port.test.ts"),
  backend("storage-postgres/structured", "src/storage/postgres/readers/structured.ts", "test/storage/postgres-structured-port.test.ts"),
  backend("storage-postgres/full-text", "src/storage/postgres/readers/full-text.ts", "test/storage/postgres-full-text-port.test.ts"),
  backend("storage-postgres/list", "src/storage/postgres/records/list.ts", "test/storage/postgres-list-port.test.ts"),
  backend("storage-postgres/facts", "src/storage/postgres/records/facts.ts", "test/storage/postgres-facts-port.test.ts"),
  backend("storage-postgres/remember", "src/storage/postgres/writes/remember.ts", "test/storage/postgres-remember.test.ts"),
  backend("storage-postgres/forget", "src/storage/postgres/writes/forget.ts", "test/storage/postgres-operations-write.test.ts"),
  backend("storage-postgres/history", "src/storage/postgres/records/history.ts", "test/storage/postgres-operations-read.test.ts"),
  backend("storage-inmemory/remember", "src/storage/inmemory/writes/remember.ts", "test/storage/inmemory-remember.test.ts"),
  backend("storage-inmemory/forget", "src/storage/inmemory/writes/forget.ts", "test/storage/inmemory-forget.test.ts"),
  backend("storage-inmemory/list", "src/storage/inmemory/records/list.ts", "test/storage/inmemory-list.test.ts"),
  backend("storage-inmemory/history", "src/storage/inmemory/records/history.ts", "test/storage/inmemory-history.test.ts"),
  backend("storage-inmemory/replay", "src/storage/inmemory/events/replay.ts", "test/storage/inmemory-replay.test.ts"),
  { responsibility: "retrieval/full-text-bm25", implementation: "src/storage/sqlite/readers/full-text.ts", test: "test/core/retrieval/full-text-bm25.test.ts", level: "integration" },
  { responsibility: "retrieval/structured", implementation: "src/storage/sqlite/readers/structured.ts", test: "test/core/retrieval/structured.test.ts", level: "integration" },
  { responsibility: "retrieval/exact", implementation: "src/storage/sqlite/readers/exact.ts", test: "test/core/retrieval/exact.test.ts", level: "integration" },
];
export function inspectContractMap(contracts: readonly RegisteredCoreContract[], exists: (path: string) => boolean) {
  if (!contracts.length || new Set(contracts.map(row => row.responsibility)).size !== contracts.length) throw new Error("Empty or duplicate responsibility contract map");
  const missing = contracts.flatMap(row => [row.implementation, row.test].filter(path => !exists(path)).map(path => ({ responsibility: row.responsibility, path })));
  return { passed: missing.length === 0, registeredResponsibilities: contracts.length, missing };
}
export function assertCoreContractMap(root: string) {
  const report = inspectContractMap(registeredCoreContracts, path => existsSync(join(root, path)));
  if (!report.passed) throw new Error("Registered implementation/test contract is missing");
  return report;
}
