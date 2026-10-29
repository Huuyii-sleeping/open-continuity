import { expect, it } from "vitest";
import { materializeEvidence, mergeQueryEvidence } from "../../../src/core/query/evidence.js";
import type { EvidenceAccumulator } from "../../../src/core/query/contracts.js";
import { routeMemory } from "../../helpers/core-route-fixtures.js";
it("evidence: deduplicates snapshots while preserving query and step coverage", () => {
  const map = new Map<string, EvidenceAccumulator>();
  mergeQueryEvidence(map, [routeMemory()], "needle", "recall-1");
  mergeQueryEvidence(map, [routeMemory()], "fictional", "recall-2");
  const evidence = materializeEvidence(map, [], false, new Set());
  expect(evidence).toHaveLength(1);
  expect(evidence[0]).toMatchObject({ matchedQueries: ["needle", "fictional"], stepIds: ["recall-1", "recall-2"] });
});
it("evidence: rejects mixed versions of the same memory", () => {
  const map = new Map<string, EvidenceAccumulator>();
  mergeQueryEvidence(map, [routeMemory()], "needle", "recall-1");
  expect(() => mergeQueryEvidence(map, [routeMemory({ version: 2 })], "needle", "recall-2")).toThrow(expect.objectContaining({ code: "STORAGE_ERROR" }));
});
