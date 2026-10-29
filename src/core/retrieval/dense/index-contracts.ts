import type { ParsedRecallInput, ResolvedMemory } from "../../../shared/types.js";

export interface EmbeddingModelSpec { fingerprint: string; dimensions: number; textVersion: "memory-value-v1"; }
export interface EmbeddingSession {
  readonly model: EmbeddingModelSpec;
  embed(texts: readonly string[], mode: "query" | "document"): Promise<readonly (readonly number[])[]>;
  close(): Promise<void>;
}
export interface EmbeddingProvider {
  readonly model: EmbeddingModelSpec;
  /** Explicit local loader. Must reject a session whose artifacts/runtime do not match model. */
  load(): Promise<EmbeddingSession>;
}
export interface DenseIndexTask {
  userId: string; memory: ResolvedMemory; modelFingerprint: string;
}
export interface DenseVectorPopulation {
  entries: Array<{ memory: ResolvedMemory; vector: number[] }>;
  complete: boolean; revision: string;
}
export interface DenseIndexCoverage { complete: boolean; count: number; revision: string; }
export interface DenseMemoryReference { id: string; sourceEventId: string; version: number; updatedAt: string; }
export interface DenseVectorIndex {
  readonly model: EmbeddingModelSpec;
  revision(): string;
  pending(input: ParsedRecallInput, limit: number): DenseIndexTask[];
  commit(task: DenseIndexTask, vector: readonly number[]): boolean;
  coverage(input: ParsedRecallInput, maximum: number): DenseIndexCoverage;
  scan(input: ParsedRecallInput, maximum: number, visit: (memory: ResolvedMemory, vector: Float32Array) => void): DenseIndexCoverage;
  /** Optional projection ports; eligibility must precede scanning and hydration. */
  scanVectors?(input: ParsedRecallInput, maximum: number, visit: (reference: DenseMemoryReference, vector: Float32Array) => void): DenseIndexCoverage;
  readCurrent?(input: ParsedRecallInput, references: readonly DenseMemoryReference[], revision: string): ResolvedMemory[];
  /** Inspection helper; the runtime uses streaming scan instead. */
  population(input: ParsedRecallInput, maximum: number): DenseVectorPopulation;
}
