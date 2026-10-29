import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import type { DenseIndexTask, DenseVectorIndex, DenseVectorPopulation, EmbeddingModelSpec, DenseIndexCoverage, DenseMemoryReference } from "../../core/retrieval/dense/index-contracts.js";
import { validateEmbeddingModel, validateVector } from "../../core/retrieval/dense/vectors.js";
import type { ParsedRecallInput } from "../../shared/types.js";
import { OpenContinuityError } from "../../shared/errors.js";
import { sqliteCandidateEligibility } from "./readers/eligibility.js";
import { rowToMemory, type SqliteRow } from "./row-mapping.js";

/** Optional, rebuildable tables. Current/event authority and their schema version are unchanged. */
export class SqliteDenseIndex implements DenseVectorIndex {
  private readonly epoch: string;
  readonly model: Readonly<EmbeddingModelSpec>;
  constructor(private readonly database: DatabaseSync, model: EmbeddingModelSpec, reset = false) {
    validateEmbeddingModel(model); this.model = Object.freeze({ ...model });
    try {
      database.exec("BEGIN IMMEDIATE");
      database.exec(`CREATE TABLE IF NOT EXISTS memory_dense_config (
        singleton INTEGER PRIMARY KEY CHECK(singleton=1), model TEXT NOT NULL, dimensions INTEGER NOT NULL,
        text_version TEXT NOT NULL, epoch TEXT NOT NULL, generation INTEGER NOT NULL DEFAULT 0);
        CREATE TABLE IF NOT EXISTS memory_dense_vectors (
        memory_id TEXT PRIMARY KEY REFERENCES memories_current(id) ON DELETE CASCADE,
        source_event_id TEXT NOT NULL, version INTEGER NOT NULL, model TEXT NOT NULL, vector BLOB NOT NULL);
        CREATE TABLE IF NOT EXISTS memory_dense_jobs (
        memory_id TEXT PRIMARY KEY REFERENCES memories_current(id) ON DELETE CASCADE, model TEXT NOT NULL);
        CREATE TRIGGER IF NOT EXISTS memory_dense_vector_insert AFTER INSERT ON memory_dense_vectors BEGIN
          UPDATE memory_dense_config SET generation=generation+1 WHERE singleton=1;
        END;
        CREATE TRIGGER IF NOT EXISTS memory_dense_vector_update AFTER UPDATE ON memory_dense_vectors BEGIN
          UPDATE memory_dense_config SET generation=generation+1 WHERE singleton=1;
        END;
        CREATE TRIGGER IF NOT EXISTS memory_dense_vector_delete AFTER DELETE ON memory_dense_vectors BEGIN
          UPDATE memory_dense_config SET generation=generation+1 WHERE singleton=1;
        END;
        CREATE TRIGGER IF NOT EXISTS memory_dense_insert AFTER INSERT ON memories_current BEGIN
          INSERT OR REPLACE INTO memory_dense_jobs SELECT NEW.id,model FROM memory_dense_config WHERE singleton=1 AND NEW.user_confirmed=1;
          UPDATE memory_dense_config SET generation=generation+1 WHERE singleton=1;
        END;
        CREATE TRIGGER IF NOT EXISTS memory_dense_update AFTER UPDATE ON memories_current BEGIN
          DELETE FROM memory_dense_vectors WHERE memory_id=NEW.id;
          DELETE FROM memory_dense_jobs WHERE memory_id=NEW.id;
          INSERT OR REPLACE INTO memory_dense_jobs SELECT NEW.id,model FROM memory_dense_config WHERE singleton=1 AND NEW.user_confirmed=1;
          UPDATE memory_dense_config SET generation=generation+1 WHERE singleton=1;
        END;
        CREATE TRIGGER IF NOT EXISTS memory_dense_delete AFTER DELETE ON memories_current BEGIN
          DELETE FROM memory_dense_vectors WHERE memory_id=OLD.id;
          DELETE FROM memory_dense_jobs WHERE memory_id=OLD.id;
          UPDATE memory_dense_config SET generation=generation+1 WHERE singleton=1;
        END;`);
      const existing = database.prepare("SELECT * FROM memory_dense_config WHERE singleton=1").get();
      if (existing && (existing.model !== model.fingerprint || existing.dimensions !== model.dimensions || existing.text_version !== model.textVersion) && !reset) {
        throw new OpenContinuityError("VALIDATION_ERROR", "Dense model changed; explicitly reset the derived index", 400);
      }
      if (!existing || reset) {
        database.prepare(`INSERT INTO memory_dense_config(singleton,model,dimensions,text_version,epoch,generation) VALUES(1,?,?,?,?,1)
          ON CONFLICT(singleton) DO UPDATE SET model=excluded.model,dimensions=excluded.dimensions,text_version=excluded.text_version,epoch=excluded.epoch,generation=memory_dense_config.generation+1`).run(model.fingerprint, model.dimensions, model.textVersion, randomUUID());
        database.exec("DELETE FROM memory_dense_vectors; DELETE FROM memory_dense_jobs;");
      }
      database.prepare(`INSERT OR IGNORE INTO memory_dense_jobs SELECT m.id,? FROM memories_current m
        WHERE m.user_confirmed=1 AND NOT EXISTS(SELECT 1 FROM memory_dense_vectors v WHERE v.memory_id=m.id AND v.source_event_id=m.source_event_id AND v.model=?)`).run(model.fingerprint, model.fingerprint);
      this.epoch = String(database.prepare("SELECT epoch FROM memory_dense_config WHERE singleton=1").get()!.epoch);
      database.exec("COMMIT");
    } catch (error) { if (database.isTransaction) database.exec("ROLLBACK"); throw error; }
  }
  private assertModel() {
    const row = this.database.prepare("SELECT * FROM memory_dense_config WHERE singleton=1").get();
    if (!row || row.model !== this.model.fingerprint || row.dimensions !== this.model.dimensions || row.text_version !== this.model.textVersion || row.epoch !== this.epoch) throw new OpenContinuityError("STORAGE_ERROR", "Dense index model is no longer active", 500);
    return row;
  }
  revision(): string { return `${this.epoch}:${this.assertModel().generation}`; }
  private eligible(input: ParsedRecallInput) { return sqliteCandidateEligibility({ ...input, cursor: undefined, channel: "dense", requireUserConfirmed: true, lexicalFallback: false }); }
  pending(input: ParsedRecallInput, limit: number): DenseIndexTask[] {
    this.assertModel(); this.budget(limit, 100);
    const { clauses, values } = this.eligible(input);
    return (this.database.prepare(`SELECT m.* FROM memory_dense_jobs j JOIN memories_current m ON m.id=j.memory_id
      WHERE j.model=? AND ${clauses.join(" AND ")} ORDER BY m.updated_at,m.id LIMIT ?`).all(this.model.fingerprint, ...values, limit) as SqliteRow[])
      .map(row => ({ userId: input.userId, memory: rowToMemory(row), modelFingerprint: this.model.fingerprint }));
  }
  commit(task: DenseIndexTask, vector: readonly number[]): boolean {
    this.assertModel(); validateVector(vector, this.model.dimensions);
    if (task.modelFingerprint !== this.model.fingerprint) return false;
    const bytes = Buffer.alloc(vector.length * 4); vector.forEach((value, index) => bytes.writeFloatLE(value, index * 4));
    try {
      this.database.exec("BEGIN IMMEDIATE");
      this.assertModel();
      const current = this.database.prepare(`SELECT m.id FROM memories_current m JOIN memory_dense_jobs j ON j.memory_id=m.id
        WHERE m.id=? AND m.user_id=? AND m.source_event_id=? AND m.version=? AND m.user_confirmed=1 AND j.model=?`).get(
        task.memory.id, task.userId, task.memory.sourceEventId, task.memory.version, this.model.fingerprint);
      if (!current) { this.database.exec("ROLLBACK"); return false; }
      this.database.prepare(`INSERT OR REPLACE INTO memory_dense_vectors(memory_id,source_event_id,version,model,vector) VALUES(?,?,?,?,?)`).run(
        task.memory.id, task.memory.sourceEventId, task.memory.version, this.model.fingerprint, bytes);
      this.database.prepare("DELETE FROM memory_dense_jobs WHERE memory_id=?").run(task.memory.id);
      this.database.exec("UPDATE memory_dense_config SET generation=generation+1 WHERE singleton=1; COMMIT;");
      return true;
    } catch (error) { if (this.database.isTransaction) this.database.exec("ROLLBACK"); throw error; }
  }
  private coverageInTransaction(input: ParsedRecallInput, maximum: number): DenseIndexCoverage {
    const revision = this.revision();
    const { clauses, values } = this.eligible(input);
    const count = Number(this.database.prepare(`SELECT count(*) AS n FROM memories_current m WHERE ${clauses.join(" AND ")}`).get(...values)!.n);
    const missing = this.database.prepare(`SELECT 1 FROM memories_current m WHERE ${clauses.join(" AND ")}
      AND NOT EXISTS(SELECT 1 FROM memory_dense_vectors v WHERE v.memory_id=m.id AND v.source_event_id=m.source_event_id AND v.version=m.version AND v.model=?) LIMIT 1`).get(...values, this.model.fingerprint);
    return { revision, count, complete: !missing && count <= maximum };
  }
  coverage(input: ParsedRecallInput, maximum: number): DenseIndexCoverage {
    this.budget(maximum, 20000);
    try { this.database.exec("BEGIN"); const result = this.coverageInTransaction(input, maximum); this.database.exec("COMMIT"); return result; }
    catch (error) { if (this.database.isTransaction) this.database.exec("ROLLBACK"); throw error; }
  }
  private readVector(row: SqliteRow): Float32Array {
    if (!(row.vector instanceof Uint8Array) || row.vector.byteLength !== this.model.dimensions * 4)
      throw new OpenContinuityError("STORAGE_ERROR", "Dense vector storage is invalid", 500);
    const bytes = Buffer.from(row.vector.buffer, row.vector.byteOffset, row.vector.byteLength), vector = new Float32Array(this.model.dimensions);
    for (let index = 0; index < vector.length; index++) vector[index] = bytes.readFloatLE(index * 4);
    validateVector(vector, this.model.dimensions); return vector;
  }
  private scanRows(input: ParsedRecallInput, maximum: number, projection: string, visit: (row: SqliteRow, vector: Float32Array) => void): DenseIndexCoverage {
    this.budget(maximum, 20000);
    try {
      this.database.exec("BEGIN"); const result = this.coverageInTransaction(input, maximum);
      if (result.complete) {
        const { clauses, values } = this.eligible(input);
        const rows = this.database.prepare(`SELECT ${projection},v.vector FROM memories_current m JOIN memory_dense_vectors v
          ON v.memory_id=m.id AND v.source_event_id=m.source_event_id AND v.version=m.version AND v.model=?
          WHERE ${clauses.join(" AND ")} ORDER BY m.id LIMIT ?`).iterate(this.model.fingerprint, ...values, maximum);
        for (const raw of rows) { const row = raw as SqliteRow; visit(row, this.readVector(row)); }
      }
      this.database.exec("COMMIT"); return result;
    } catch (error) { if (this.database.isTransaction) this.database.exec("ROLLBACK"); throw error; }
  }
  scan(input: ParsedRecallInput, maximum: number, visit: (memory: ReturnType<typeof rowToMemory>, vector: Float32Array) => void): DenseIndexCoverage {
    return this.scanRows(input, maximum, "m.*", (row, vector) => visit(rowToMemory(row), vector));
  }
  scanVectors(input: ParsedRecallInput, maximum: number, visit: (reference: DenseMemoryReference, vector: Float32Array) => void): DenseIndexCoverage {
    return this.scanRows(input, maximum, "m.id,m.source_event_id,m.version,m.updated_at", (row, vector) => visit({
      id: String(row.id), sourceEventId: String(row.source_event_id), version: Number(row.version), updatedAt: String(row.updated_at) }, vector));
  }
  readCurrent(input: ParsedRecallInput, references: readonly DenseMemoryReference[], revision: string) {
    if (references.length > 100 || new Set(references.map(item => item.id)).size !== references.length)
      throw new OpenContinuityError("VALIDATION_ERROR", "Invalid Dense hydration budget", 400);
    try {
      this.database.exec("BEGIN");
      if (this.revision() !== revision) throw new OpenContinuityError("STORAGE_ERROR", "Dense hydration revision changed", 500);
      const { clauses, values } = this.eligible(input);
      const rows = references.length ? this.database.prepare(`SELECT m.* FROM memories_current m WHERE ${clauses.join(" AND ")}
        AND m.id IN (${references.map(() => "?").join(",")})`).all(...values, ...references.map(item => item.id)) as SqliteRow[] : [];
      const expected = new Map(references.map(item => [item.id, item]));
      const memories = rows.map(rowToMemory);
      if (memories.length !== references.length || memories.some(memory => { const reference = expected.get(memory.id);
        return !reference || reference.sourceEventId !== memory.sourceEventId || reference.version !== memory.version; }))
        throw new OpenContinuityError("STORAGE_ERROR", "Dense hydration changed eligibility or version", 500);
      this.database.exec("COMMIT"); return memories;
    } catch (error) { if (this.database.isTransaction) this.database.exec("ROLLBACK"); throw error; }
  }
  population(input: ParsedRecallInput, maximum: number): DenseVectorPopulation {
    const entries: DenseVectorPopulation["entries"] = [];
    const result = this.scan(input, maximum, (memory, vector) => entries.push({ memory, vector: Array.from(vector) }));
    return { entries, complete: result.complete, revision: result.revision };
  }
  private budget(value: number, maximum: number) {
    if (!Number.isInteger(value) || value < 1 || value > maximum) throw new OpenContinuityError("VALIDATION_ERROR", "Invalid Dense index work budget", 400);
  }
}
