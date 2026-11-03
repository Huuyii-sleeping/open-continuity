import type { ParsedRecallInput, ResolvedMemory } from "../../../shared/types.js";
import { OpenContinuityError } from "../../../shared/errors.js";
import type { DenseIndexCoverage, DenseMemoryReference, DenseVectorIndex } from "./index-contracts.js";
import { DenseSnapshotCache, type DenseCachePolicy, type DenseVectorSnapshot } from "./snapshot-cache.js";
import { cosineSimilarity } from "./vectors.js";

export interface DenseRankingReceipt { engine: "vector_projection_v1" | "legacy_stream"; cache: "hit" | "miss" | "bypassed";
  populationCount: number; vectorBytes: number; hydratedCount: number; }
interface RankedReference { reference: DenseMemoryReference; score: number; }
function compare(a: RankedReference, b: RankedReference) {
  return b.score - a.score || b.reference.updatedAt.localeCompare(a.reference.updatedAt) || b.reference.id.localeCompare(a.reference.id);
}
export class DenseCandidateRanker {
  readonly cache: DenseSnapshotCache;
  constructor(private readonly index: DenseVectorIndex, policy: Partial<DenseCachePolicy> = {}) { this.cache = new DenseSnapshotCache(policy); }
  coverage(input: ParsedRecallInput, maximum: number): DenseIndexCoverage {
    const revision = this.index.revision(), key = this.cache.key(input, revision, this.index.model.fingerprint, maximum);
    const snapshot = this.cache.get(key);
    return snapshot ? { revision, count: snapshot.references.length, complete: true } : this.index.coverage(input, maximum);
  }
  rank(input: ParsedRecallInput, query: readonly number[], maximum: number, coverage: DenseIndexCoverage, check: () => void, threshold: number) {
    check(); if (this.index.revision() !== coverage.revision) return null;
    const ranked: RankedReference[] = [];
    let aboveThreshold = 0;
    const consider = (reference: DenseMemoryReference, score: number) => {
      // Keep only the true best 100; all eligible rows are compared.
      const entry = { reference, score };
      if (ranked.length === 100 && compare(entry, ranked[99]!) >= 0) return false;
      const position = ranked.findIndex(previous => compare(entry, previous) < 0);
      ranked.splice(position < 0 ? ranked.length : position, 0, entry); if (ranked.length > 100) ranked.pop(); return true;
    };
    const rememberScore = (score: number) => { if (score >= threshold) aboveThreshold++; };
    const key = this.cache.key(input, coverage.revision, this.index.model.fingerprint, maximum);
    const projection = Boolean(this.index.scanVectors && this.index.readCurrent);
    let snapshot = projection ? this.cache.get(key) : undefined;
    let receipt: DenseRankingReceipt = { engine: projection ? "vector_projection_v1" : "legacy_stream", cache: snapshot ? "hit" : "bypassed", populationCount: coverage.count, vectorBytes: 0, hydratedCount: 0 };
    const memoryMap = new Map<string, ResolvedMemory>();
    if (snapshot) {
      const querySquared = query.reduce((sum, value) => sum + value * value, 0);
      for (let row = 0; row < snapshot.references.length; row++) {
        if (row % 64 === 0) check();
        let dot = 0; const start = row * snapshot.dimensions;
        for (let column = 0; column < query.length; column++) dot += snapshot.vectors[start + column]! * query[column]!;
        const score = Math.max(-1, Math.min(1, dot / Math.sqrt(snapshot.normSquared[row]! * querySquared)));
        rememberScore(score); consider(snapshot.references[row]!, score);
      }
      receipt.vectorBytes = snapshot.vectors.byteLength;
    } else if (projection) {
      const dimensions = this.index.model.dimensions;
      // Typed-array bytes plus conservative reference storage accounting; not an RSS guarantee.
      const estimatedBytes = coverage.count * (dimensions * 4 + 8 + 768);
      const candidate: DenseVectorSnapshot | undefined = estimatedBytes <= this.cache.policy.maxBytes && estimatedBytes > 0
        ? { revision: coverage.revision, references: [], vectors: new Float32Array(coverage.count * dimensions), normSquared: new Float64Array(coverage.count), dimensions, bytes: estimatedBytes } : undefined;
      let row = 0;
      const scanned = this.index.scanVectors!(input, maximum, (reference, vector) => {
        check();
        if (row >= coverage.count) throw new OpenContinuityError("STORAGE_ERROR", "Dense projection count changed", 500);
        const score = cosineSimilarity(vector, query); rememberScore(score); consider(reference, score);
        if (candidate) {
          candidate.references.push(reference); candidate.vectors.set(vector, row * dimensions);
          let squared = 0; for (const value of vector) squared += value * value; candidate.normSquared[row] = squared;
        }
        row++;
      });
      if (!scanned.complete || scanned.revision !== coverage.revision || row !== coverage.count) { candidate?.vectors.fill(0); return null; }
      if (candidate && this.cache.put(key, candidate)) { snapshot = candidate; receipt = { ...receipt, cache: "miss", vectorBytes: candidate.vectors.byteLength }; }
    } else {
      const scanned = this.index.scan(input, maximum, (memory, vector) => { check(); const score = cosineSimilarity(vector, query);
        rememberScore(score); if (consider(memory, score)) {
          memoryMap.set(memory.id, memory);
          if (memoryMap.size > 100) { const kept = new Set(ranked.map(item => item.reference.id)); for (const id of memoryMap.keys()) if (!kept.has(id)) memoryMap.delete(id); }
        } });
      if (!scanned.complete || scanned.revision !== coverage.revision) return null;
    }
    check(); if (this.index.revision() !== coverage.revision) { this.cache.clear(); return null; }
    if (projection) {
      for (const memory of this.index.readCurrent!(input, ranked.map(entry => entry.reference), coverage.revision)) memoryMap.set(memory.id, memory);
    }
    const memories = ranked.map(entry => {
      const memory = memoryMap.get(entry.reference.id);
      if (!memory || memory.sourceEventId !== entry.reference.sourceEventId || memory.version !== entry.reference.version)
        throw new OpenContinuityError("STORAGE_ERROR", "Dense hydration changed the current version", 500);
      return { memory, score: entry.score };
    });
    receipt.hydratedCount = memories.length;
    return { ranked: memories, receipt, aboveThreshold };
  }
  close() { this.cache.clear(); }
}
