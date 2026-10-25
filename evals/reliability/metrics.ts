export function latency(samples: number[]) {
  const sorted = [...samples].sort((a, b) => a - b);
  const percentile = (p: number) => sorted.length ? sorted[Math.ceil(sorted.length * p) - 1]! : null;
  return { count: samples.length, p50: percentile(.5), p95: percentile(.95), p99: percentile(.99), max: sorted.at(-1) ?? null, samplesMs: samples };
}
export interface ReliabilityObservation {
  outcome: "completed" | "busy" | "timeout" | "failed"; keys: string[];
  budget?: { used: number; requested: number }; coveredQueries?: number; answerStatus?: string;
  items?: Array<{ memoryId: string; version: number; sourceEventId: string }>;
  citations?: Array<{ memoryId: string; version: number; sourceEventId: string }>;
}
export function validObservation(operation: string, row: ReliabilityObservation): boolean {
  if (row.outcome !== "completed") return false;
  const keys = [...row.keys].sort().join(",");
  if (operation === "recall") return keys === "fictional-alpha,fictional-forbidden-4";
  if (!row.budget || !Number.isFinite(row.budget.used) || !Number.isFinite(row.budget.requested)
    || row.budget.requested < 64 || row.budget.used < 0 || row.budget.used > row.budget.requested) return false;
  if (operation === "context") return keys === "fictional-alpha";
  return operation === "query" && keys === "fictional-alpha,fictional-beta" && row.coveredQueries === 2
    && row.answerStatus === "evidence_ready" && row.items?.length === 2 && row.citations?.length === 2
    && new Set(row.items.map(item => item.memoryId)).size === 2
    && new Set(row.citations.map(item => item.memoryId)).size === 2
    && [...row.items, ...row.citations].every(item => typeof item.memoryId === "string" && item.memoryId.length > 0
      && typeof item.sourceEventId === "string" && item.sourceEventId.length > 0 && Number.isInteger(item.version) && item.version >= 1)
    && row.citations.every(citation => row.items!.some(item => item.memoryId === citation.memoryId && item.version === citation.version && item.sourceEventId === citation.sourceEventId));
}
export interface ReliabilityRow {
  size: number; round: number; recordRepeats: number; operation: string; offeredConcurrency: number;
  responses: number; completed: number; busy: number; timeout: number; failed: number; invalid: number;
  latency: ReturnType<typeof latency>; rssSnapshotMax: number; yieldLagMs: number[];
  observations: ReliabilityObservation[];
}
export interface ReliabilityReport {
  format: "core-reliability-v1";
  evaluatorHash: string;
  settings: { sizes: number[]; rounds: number; samples: number; warmups: number; concurrency: number[]; recordRepeats: number[] };
  environment: { node: string; platform: string; arch: string };
  sourceHash: string;
  rows: ReliabilityRow[];
  valid: boolean;
}
export function compareReliability(before: ReliabilityReport, after: ReliabilityReport) {
  if (before.format !== "core-reliability-v1" || after.format !== before.format || before.evaluatorHash !== after.evaluatorHash
    || JSON.stringify(before.settings) !== JSON.stringify(after.settings) || JSON.stringify(before.environment) !== JSON.stringify(after.environment)) {
    throw new Error("Incomparable reliability reports");
  }
  const key = (row: ReliabilityRow) => `${row.size}/${row.round}/${row.recordRepeats}/${row.operation}/${row.offeredConcurrency}`;
  const expected = before.settings.sizes.length * before.settings.rounds * before.settings.concurrency.length * before.settings.recordRepeats.length * 3;
  for (const report of [before, after]) {
    if (report.rows.length !== expected || new Set(report.rows.map(key)).size !== expected) throw new Error("Incomplete reliability grid");
    for (const row of report.rows) {
      if (!report.settings.sizes.includes(row.size) || row.round < 1 || row.round > report.settings.rounds
        || !report.settings.recordRepeats.includes(row.recordRepeats)
        || !report.settings.concurrency.includes(row.offeredConcurrency) || !["recall", "context", "query"].includes(row.operation)
        || row.responses !== report.settings.samples || row.responses !== row.completed + row.busy + row.timeout + row.failed
        || row.latency.count !== row.responses || row.latency.samplesMs.length !== row.responses
        || row.observations.length !== row.responses
        || row.latency.samplesMs.some(n => !Number.isFinite(n) || n < 0) || row.invalid < 0
        || [row.completed, row.busy, row.timeout, row.failed, row.invalid].some(n => !Number.isInteger(n) || n < 0)) throw new Error("Invalid reliability observations");
      if (JSON.stringify(latency(row.latency.samplesMs)) !== JSON.stringify(row.latency)) throw new Error("Invalid latency summary");
      for (const outcome of ["completed", "busy", "timeout", "failed"] as const) {
        if (row[outcome] !== row.observations.filter(item => item.outcome === outcome).length) throw new Error("Invalid response counts");
      }
      if (row.invalid !== row.observations.filter(item => item.outcome === "completed" && !validObservation(row.operation, item)).length) throw new Error("Invalid response validity");
    }
    if (report.valid !== report.rows.every(row => !row.invalid && !row.failed && !row.timeout && !row.busy)) throw new Error("Invalid report gate");
  }
  const previous = new Map(before.rows.map(row => [key(row), row]));
  return after.rows.map(row => {
    const old = previous.get(key(row)); if (!old) throw new Error("Mismatched workload");
    return { workload: key(row), beforeP95: old.latency.p95, afterP95: row.latency.p95,
      deltaP95: row.latency.p95! - old.latency.p95!, beforeErrors: old.failed + old.timeout + old.busy,
      afterErrors: row.failed + row.timeout + row.busy, beforeInvalid: old.invalid, afterInvalid: row.invalid };
  });
}

/** Fixed synthetic same-host regression budget, declared before measurement. Not a production SLO. */
export function performanceRegression(before: ReliabilityReport, after: ReliabilityReport) {
  compareReliability(before, after);
  const groups = new Map<string, { before: number[]; after: number[] }>();
  for (const row of after.rows) {
    const key = `${row.size}/${row.recordRepeats}/${row.operation}/${row.offeredConcurrency}`;
    const reference = before.rows.find(old => old.size === row.size && old.round === row.round && old.recordRepeats === row.recordRepeats
      && old.operation === row.operation && old.offeredConcurrency === row.offeredConcurrency)!;
    const group = groups.get(key) ?? { before: [], after: [] };
    group.before.push(reference.latency.p95!); group.after.push(row.latency.p95!); groups.set(key, group);
  }
  const observations = [...groups].map(([workload, values]) => {
    const beforeMedianP95 = latency(values.before).p50!, afterMedianP95 = latency(values.after).p50!;
    const limitMs = beforeMedianP95 * 1.5 + 0.5;
    return { workload, beforeMedianP95, afterMedianP95, limitMs, passed: afterMedianP95 <= limitMs };
  });
  return { rule: "median across three rebuilt rounds of P95 <= reference median * 1.5 + 0.5ms", sufficientRounds: before.settings.rounds >= 3,
    passed: before.settings.rounds >= 3 && observations.every(row => row.passed), observations };
}
