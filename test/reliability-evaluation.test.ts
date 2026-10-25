import { describe, expect, it } from "vitest";
import { compareReliability, latency, performanceRegression, validObservation, type ReliabilityReport } from "../evals/reliability/metrics.js";

function report(): ReliabilityReport {
  const settings = { sizes: [100], rounds: 1, samples: 10, warmups: 10, concurrency: [1], recordRepeats: [1] };
  return { format: "core-reliability-v1", evaluatorHash: "fictional-hash", sourceHash: "fictional-source", settings,
    environment: { node: "fictional-node", platform: "fictional-platform", arch: "fictional-arch" }, valid: true,
    rows: ["recall", "context", "query"].map(operation => ({ size: 100, round: 1, recordRepeats: 1, operation, offeredConcurrency: 1,
      responses: 10, completed: 10, busy: 0, timeout: 0, failed: 0, invalid: 0, latency: latency(Array(10).fill(1)), rssSnapshotMax: 100, yieldLagMs: [1],
      observations: Array.from({ length: 10 }, () => ({ outcome: "completed" as const,
        keys: operation === "recall" ? ["fictional-alpha", "fictional-forbidden-4"] : operation === "context" ? ["fictional-alpha"] : ["fictional-alpha", "fictional-beta"],
        budget: { used: 10, requested: 100 }, coveredQueries: 2, answerStatus: "evidence_ready",
        items: ["a", "b"].map(memoryId => ({ memoryId, version: 1, sourceEventId: `event-${memoryId}` })),
        citations: ["a", "b"].map(memoryId => ({ memoryId, version: 1, sourceEventId: `event-${memoryId}` })),
      })) })) };
}
describe("5C reliability evidence validation", () => {
  it("recomputes latency and validates raw response selection", () => {
    expect(compareReliability(report(), report())).toHaveLength(3);
    expect(latency([3, 1, 2])).toMatchObject({ p50: 2, p95: 3, p99: 3 });
    expect(validObservation("query", { outcome: "completed", keys: ["fictional-alpha"] })).toBe(false);
  });
  it("rejects missing rows, forged percentiles/counts/gates and invalid citations", () => {
    for (const mutate of [
      (r: ReliabilityReport) => { r.rows.pop(); },
      (r: ReliabilityReport) => { r.rows[0]!.latency.p95 = 0; },
      (r: ReliabilityReport) => { r.rows[0]!.completed = 9; },
      (r: ReliabilityReport) => { r.valid = false; },
      (r: ReliabilityReport) => { r.rows[2]!.observations[0]!.citations![0]!.version = 2; },
      (r: ReliabilityReport) => { r.rows[2]!.observations[0]!.citations![0]!.version = 0; r.rows[2]!.observations[0]!.items![0]!.version = 0; },
      (r: ReliabilityReport) => { r.rows[2]!.observations[0]!.items![1] = r.rows[2]!.observations[0]!.items![0]!; },
      (r: ReliabilityReport) => { r.rows[2]!.observations[0]!.budget!.requested = NaN; },
      (r: ReliabilityReport) => { r.rows[2]!.observations[0]!.citations![0]!.sourceEventId = ""; r.rows[2]!.observations[0]!.items![0]!.sourceEventId = ""; },
      (r: ReliabilityReport) => { r.rows[0]!.observations[0]!.keys = ["fictional-other-user"]; },
    ]) {
      const broken = report(); mutate(broken); expect(() => compareReliability(report(), broken)).toThrow();
    }
  });
  it("rejects different environments, settings and evaluator contracts", () => {
    for (const mutate of [
      (r: ReliabilityReport) => { r.environment.node = "different"; },
      (r: ReliabilityReport) => { r.settings.samples = 20; },
      (r: ReliabilityReport) => { r.evaluatorHash = "different"; },
    ]) { const broken = report(); mutate(broken); expect(() => compareReliability(report(), broken)).toThrow("Incomparable"); }
  });
  it("requires three rounds and detects the predeclared latency regression without removing samples", () => {
    expect(performanceRegression(report(), report()).passed).toBe(false);
    const before = report(); before.settings.rounds = 3;
    const initial = before.rows; before.rows = [1, 2, 3].flatMap(round => initial.map(row => ({ ...structuredClone(row), round })));
    const after = structuredClone(before); after.rows[0]!.latency = latency(Array(10).fill(100)); after.rows[3]!.latency = latency(Array(10).fill(100));
    expect(performanceRegression(before, before).passed).toBe(true);
    expect(performanceRegression(before, after).passed).toBe(false);
    expect(after.rows[0]!.latency.samplesMs).toHaveLength(10);
  });
});
