export type ReadStage = "lookup" | "list" | "candidates" | "history" | "fact_group" | "dense";
export interface ReadStageReceipt { stage: ReadStage; started: number; settled: number; failed: number; durationMs: number; }

export const READ_RUNTIME_VERSION = "bounded-reads-v1" as const;

export type ReadOperation = "recall" | "context" | "query" | "history" | "handoff_resume";
export interface ReadRuntimeReceipt {
  version: typeof READ_RUNTIME_VERSION; operation: ReadOperation;
  outcome: "completed" | "timeout" | "busy" | "failed" | "closed";
  elapsedMs: number; readsStarted: number; activeRequests: number; pendingReads: number;
  stages: readonly Readonly<ReadStageReceipt>[];
}
export type ReadRuntimeObserver = (receipt: Readonly<ReadRuntimeReceipt>) => void;
