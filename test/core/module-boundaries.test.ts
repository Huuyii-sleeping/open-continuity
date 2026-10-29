import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { boundaryViolations, inspectCoreBoundaries } from "../../scripts/check-core-boundaries.js";

describe("modular Core dependencies", () => {
  it("checks the real repository, including compatibility entry points", () => {
    const root = fileURLToPath(new URL("../../", import.meta.url));
    const report = inspectCoreBoundaries(root);
    expect(report.sources).toBeGreaterThan(30);
    expect(report.edges).toBeGreaterThan(30);
    expect(report.violations).toEqual([]);
  });
  it("rejects SQL leakage, concrete consumers, and cross-channel dependencies", () => {
    const edges = [
      { from: "src/core/context/pack.ts", to: "src/storage/sqlite/sqlite-memory-store.ts" },
      { from: "src/core/query/engine.ts", to: "src/core/retrieval/pipeline.ts" },
      { from: "src/core/retrieval/retrievers/exact.ts", to: "src/core/retrieval/retrievers/full-text.ts" },
      { from: "src/storage/sqlite/readers/exact.ts", to: "src/storage/sqlite/readers/structured.ts" },
      { from: "src/storage/postgres/postgres-memory-store.ts", to: "src/core/application/memory-service.ts" },
      { from: "src/core/runtime/profile.ts", to: "src/core/application/store-factory.ts" },
      { from: "src/core/retrieval/contracts.ts", to: "src/core/retrieval/pipeline.ts" },
      { from: "src/core/retrieval/ranking.ts", to: "node:sqlite" },
      { from: "src/core/query/engine.ts", to: "src/core/memory-service.ts" },
      { from: "src/core/query/engine.ts", to: "src/sqlite/sqlite-memory-store.ts" },
      { from: "src/core/query/history.ts", to: "src/core/query/recall.ts" },
      { from: "src/core/context/packing/rank.ts", to: "src/core/context/packing/coverage.ts" },
      { from: "src/storage/sqlite/writes/forget.ts", to: "src/storage/sqlite/writes/remember.ts" },
      { from: "src/core/runtime/deadline.ts", to: "src/core/runtime/read-runtime.ts" },
      { from: "src/core/context/selection/relevance.ts", to: "src/core/context/selection/legacy.ts" },
      { from: "src/core/runtime/store-guard.ts", to: "src/core/runtime/read-runtime.ts" },
    ];
    expect(boundaryViolations(edges)).toHaveLength(edges.length);
  });
  it("permits composition, narrow contracts and shared eligibility", () => {
    expect(boundaryViolations([
      { from: "src/core/application/memory-service.ts", to: "src/storage/inmemory/store.ts" },
      { from: "src/core/context/pack.ts", to: "src/core/retrieval/contracts.ts" },
      { from: "src/core/retrieval/candidates.ts", to: "src/core/retrieval/retrievers/full-text.ts" },
      { from: "src/storage/sqlite/readers/exact.ts", to: "src/storage/sqlite/readers/eligibility.ts" },
    ])).toEqual([]);
  });
});
