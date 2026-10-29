import { OpenContinuityError } from "../../../shared/errors.js";
import type { EmbeddingModelSpec } from "./index-contracts.js";

export function validateEmbeddingModel(model: EmbeddingModelSpec): void {
  if (!/^[a-f0-9]{64}$/.test(model.fingerprint) || !Number.isInteger(model.dimensions) || model.dimensions < 1 || model.dimensions > 4096
    || model.textVersion !== "memory-value-v1") throw new OpenContinuityError("VALIDATION_ERROR", "Invalid embedding model specification", 400);
}
export function validateVector(vector: readonly number[] | Float32Array, dimensions: number): void {
  if ((!Array.isArray(vector) && !(vector instanceof Float32Array)) || vector.length !== dimensions)
    throw new OpenContinuityError("STORAGE_ERROR", "Embedding dimension is invalid", 500);
  let squared = 0;
  for (const value of vector) {
    if (!Number.isFinite(value)) throw new OpenContinuityError("STORAGE_ERROR", "Embedding contains a nonfinite component", 500);
    squared += value * value;
  }
  if (Math.abs(Math.sqrt(squared) - 1) > .001)
    throw new OpenContinuityError("STORAGE_ERROR", "Embedding must return a finite unit vector of the configured dimension", 500);
}
export function embeddingText(value: unknown): string { return typeof value === "string" ? value : JSON.stringify(value); }

/** Both operands have already passed the model/index vector contract. Normalize float32 roundoff. */
export function cosineSimilarity(left: readonly number[] | Float32Array, right: readonly number[]): number {
  let dot = 0, leftSquared = 0, rightSquared = 0;
  for (let index = 0; index < left.length; index++) {
    const a = left[index]!, b = right[index]!; dot += a * b; leftSquared += a * a; rightSquared += b * b;
  }
  const score = dot / Math.sqrt(leftSquared * rightSquared);
  if (left.length !== right.length || !Number.isFinite(score)) throw new OpenContinuityError("STORAGE_ERROR", "Invalid cosine operands", 500);
  return Math.max(-1, Math.min(1, score));
}
