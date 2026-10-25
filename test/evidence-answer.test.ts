import { describe, expect, it } from "vitest";
import { MemoryService } from "../src/core/memory-service.js";
import { citationFor, composeEvidenceAnswer, validateEvidenceAnswer } from "../src/core/evidence-answer.js";
import type { AgenticQueryResult } from "../src/shared/types.js";
const actor = { userId: "fictional-answer-user", agentId: "fictional-answer-agent" };
async function example() {
  const service = new MemoryService();
  await service.remember({ ...actor, key: "rule", value: { rule: "never delete", conditions: ["explicit approval"], disabled: false }, kind: "decision", userConfirmed: true, idempotencyKey: "fictional-rule" });
  return service.query({ ...actor, query: "rule", strategy: "direct" });
}
describe("evidence-answer-v1", () => {
  it("projects whole memory values and cites only the exact selected versions", async () => {
    const result = await example();
    expect(result.answer).toMatchObject({ version: "evidence-answer-v1", status: "evidence_ready", mode: "memory_projection", limitations: ["no_semantic_synthesis", "not_truth_verification"] });
    expect(result.answer!.statements[0].value).toEqual(result.contextPack.items[0].value);
    expect(result.answer!.citations[0]).toEqual(citationFor(result.contextPack.items[0]));
    expect(result.answer!.statements[0]).toMatchObject({ userConfirmed: true, verification: "unverified_memory", citationId: result.answer!.citations[0].id });
    validateEvidenceAnswer(result.answer!, result.contextPack, result.evidence, result.sufficiency, false);
  });
  it("rejects invented statements, dangling or stale citations, forged coverage and bad status", async () => {
    const result = await example();
    const mutations: Array<(value: NonNullable<AgenticQueryResult["answer"]>) => void> = [
      value => { value.statements[0].value = "delete everything"; }, value => { value.citations[0].version++; },
      value => { value.citations[0].sourceEventId = "fictional-foreign-event"; }, value => { value.statements[0].citationId = "missing"; },
      value => { value.coverage.coveredQueries = 0; }, value => { value.status = "abstain"; },
    ];
    for (const mutate of mutations) {
      const answer = structuredClone(result.answer!); mutate(answer);
      expect(() => validateEvidenceAnswer(answer, result.contextPack, result.evidence, result.sufficiency, false)).toThrow("Inconsistent context evidence");
    }
  });
  it("rejects a selected item that was not in the authorized evidence set", async () => {
    const result = await example();
    expect(() => composeEvidenceAnswer(result.contextPack, [], result.sufficiency, false)).toThrow("Inconsistent context evidence");
    const tampered = structuredClone(result.contextPack); tampered.items[0].value = "invented";
    expect(() => composeEvidenceAnswer(tampered, result.evidence, result.sufficiency, false)).toThrow("Inconsistent context evidence");
    const wrongCoverage = structuredClone(result.contextPack); wrongCoverage.coverage!.requirements[0].selectedMemoryIds = [];
    expect(() => composeEvidenceAnswer(wrongCoverage, result.evidence, result.sufficiency, false)).toThrow("Inconsistent context evidence");
  });
  it("marks partial evidence, minimum-count shortfall and unexecuted obligations accurately", async () => {
    const service = new MemoryService();
    await service.remember({ ...actor, key: "alpha", value: "fictional alpha", kind: "decision", idempotencyKey: "fictional-alpha" });
    const partial = await service.query({ ...actor, query: "alpha and beta", subqueries: ["alpha", "beta"], strategy: "multi_step" });
    expect(partial.answer).toMatchObject({ status: "partial", coverage: { coveredQueries: 1, totalQueries: 2 } });
    expect(partial.answer!.citations).toHaveLength(1);
    const minimum = await service.query({ ...actor, query: "alpha", minEvidence: 2 });
    expect(minimum.sufficiency.reasons).toContain("below_min_evidence");
    expect(minimum.answer?.status).toBe("partial");
    const stopped = await service.query({ ...actor, query: "alpha and beta", subqueries: ["alpha", "beta"], strategy: "multi_step", maxSteps: 1 });
    expect(stopped.answer?.status).toBe("partial");
    expect(stopped.answer?.reasons).toContain("max_steps");
  });
  it("does not invent a timeline or treat history metadata as answer statements", async () => {
    const service = new MemoryService();
    await service.remember({ ...actor, key: "runtime", value: "fictional old", kind: "decision", idempotencyKey: "fictional-old" });
    await service.remember({ ...actor, key: "runtime", value: "fictional current", kind: "decision", idempotencyKey: "fictional-current" });
    const result = await service.query({ ...actor, query: "runtime history", includeHistory: true });
    expect(result.answer?.status).toBe("partial");
    expect(result.answer?.limitations).toContain("history_not_projected");
    expect(result.answer!.statements.map(item => item.value)).toEqual(["fictional current"]);
  });
});
