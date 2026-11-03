import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { recallInputSchema } from "../../src/shared/types.js";
import { SqliteMemoryStore } from "../../src/storage/sqlite/sqlite-memory-store.js";
import { denseActor, denseFixture, denseModel } from "../helpers/dense-fixture.js";
import { cosineSimilarity, validateVector } from "../../src/core/retrieval/dense/vectors.js";

describe("SQLite derived Dense index", () => {
  const fixtures: ReturnType<typeof denseFixture>[] = [];
  afterEach(async () => { for (const fixture of fixtures.splice(0)) await fixture.cleanup(); });
  function setup() { const fixture = denseFixture(); fixtures.push(fixture); return fixture; }
  const input = () => recallInputSchema.parse(denseActor);
  it("installs optional derived tables only when explicitly requested", () => {
    const store = new SqliteMemoryStore(":memory:");
    // Default store advertises exactly the three established readers.
    expect(Object.keys(store.candidateReaders)).toEqual(["exact", "structured", "full_text"]);
    expect(store.enableDenseIndex(denseModel).population(input(), 10).complete).toBe(true); store.close();
  });
  it.each([[NaN, 0], [Infinity, 0], [0, 0], [2, 0], [1], [1, 0, 0]].map((vector, index) => ({ label: `invalid-${index}`, vector })))("rejects invalid vector $label", ({ vector }) => {
    expect(() => validateVector(vector, 2)).toThrow();
  });
  it("filters user, agent, task, private and confirmation before pending work and population limits", async () => {
    const f = setup(); const visible = await f.remember("visible");
    await f.remember("other-user", { userId: "fictional-other" });
    await f.remember("other-agent", { scope: "agent", agentId: "fictional-other" });
    await f.remember("other-task", { scope: "task", taskId: "fictional-other" });
    await f.remember("secret", { sensitivity: "private" });
    await f.remember("unapproved", { userConfirmed: false });
    const tasks = f.index.pending(input(), 1); expect(tasks.map(task => task.memory.id)).toEqual([visible.current.id]);
    expect(f.index.commit(tasks[0]!, [1, 0])).toBe(true);
    expect(f.index.population(input(), 1)).toMatchObject({ complete: true, entries: [{ memory: { id: visible.current.id } }] });
    expect(f.index.pending(recallInputSchema.parse({ ...denseActor, includePrivate: true }), 10)).toHaveLength(1);
    expect(f.index.population(recallInputSchema.parse({ ...denseActor, kind: "decision" }), 1).entries).toEqual([]);
    expect(f.index.population(recallInputSchema.parse({ ...denseActor, scope: "agent" }), 1).complete).toBe(true);
  });
  it("makes repeated writes/commits idempotent and invalidates a previous version immediately", async () => {
    const f = setup(), first = await f.remember("current", { key: "fictional-current", idempotencyKey: "repeat" });
    const [old] = f.index.pending(input(), 10); expect(f.index.commit(old!, [1, 0])).toBe(true);
    expect(f.index.commit(old!, [1, 0])).toBe(false);
    await f.remember("current", { key: "fictional-current", idempotencyKey: "repeat" });
    expect(f.index.population(input(), 10).complete).toBe(true);
    await f.remember("updated", { key: "fictional-current", expectedVersion: first.current.version });
    expect(f.index.population(input(), 10)).toMatchObject({ complete: false, entries: [] });
    expect(f.index.commit(old!, [1, 0])).toBe(false);
    const [fresh] = f.index.pending(input(), 10); expect(fresh!.memory.version).toBe(2);
    expect(f.index.commit(fresh!, [0, 1])).toBe(true);
    await f.remember("approval withdrawn", { key: "fictional-current", userConfirmed: false });
    expect(f.index.population(input(), 10)).toMatchObject({ complete: true, entries: [] });
  });
  it("cannot write a late vector after forget or a reset through another connection", async () => {
    const f = setup(), memory = await f.remember("current"); const [task] = f.index.pending(input(), 10);
    await f.service.forget({ ...denseActor, memoryId: memory.current.id }); expect(f.index.commit(task!, [1, 0])).toBe(false);
    await f.remember("next"); const [next] = f.index.pending(input(), 10);
    const second = new SqliteMemoryStore(f.path);
    second.enableDenseIndex(denseModel, { reset: true });
    expect(() => f.index.commit(next!, [1, 0])).toThrow(/no longer active/); second.close();
  });
  it("persists vectors across reopen and rejects an implicit incompatible model switch", async () => {
    const f = setup(); await f.remember("current"); const [task] = f.index.pending(input(), 10); f.index.commit(task!, [1, 0]);
    const second = new SqliteMemoryStore(f.path), index = second.enableDenseIndex(denseModel);
    expect(index.population(input(), 10).entries[0]!.vector).toEqual([1, 0]);
    expect(() => second.enableDenseIndex({ ...denseModel, fingerprint: "b".repeat(64) })).toThrow(/explicitly reset/); second.close();
  });
  it("rolls back the current row, event and derived job together on a failed write", async () => {
    const f = setup(); const connection = new DatabaseSync(f.path);
    connection.exec("CREATE TRIGGER fictional_failure AFTER INSERT ON memories_current BEGIN SELECT RAISE(ABORT, 'fictional failure'); END;");
    await expect(f.remember("failed")).rejects.toThrow();
    expect(connection.prepare("SELECT count(*) AS n FROM memory_dense_jobs").get()!.n).toBe(0);
    expect(connection.prepare("SELECT count(*) AS n FROM memory_events").get()!.n).toBe(0); connection.close();
  });
  it("reports missing rows or a bounded population instead of inventing complete coverage", async () => {
    const f = setup(); await f.remember("a"); await f.remember("b");
    expect(f.index.population(input(), 1).complete).toBe(false);
    await f.service.synchronizeDenseIndex(denseActor);
    expect(f.index.population(input(), 1).complete).toBe(false);
    expect(f.index.population(input(), 2).complete).toBe(true);
    expect(() => f.index.pending(input(), 0)).toThrow();
  });
  it("streams the authorized population and releases its read transaction on a visitor failure", async () => {
    const f = setup(); await f.remember("a"); await f.remember("b"); await f.service.synchronizeDenseIndex(denseActor);
    let visited = 0;
    expect(f.index.scan(input(), 1, () => { visited++; }).complete).toBe(false); expect(visited).toBe(0);
    expect(() => f.index.scan(input(), 2, () => { throw new Error("fictional visitor failure"); })).toThrow(/visitor failure/);
    const coverage = f.index.scan(input(), 2, (_memory, vector) => { expect(vector).toBeInstanceOf(Float32Array); visited++; });
    expect(coverage).toMatchObject({ complete: true, count: 2 }); expect(visited).toBe(2);
    await f.remember("next"); expect(f.index.coverage(input(), 10).complete).toBe(false);
  });
  it("reports actual cosine after float32 norm roundoff", () => {
    const vector = new Float32Array([1.0004, 0]); validateVector(vector, 2);
    expect(cosineSimilarity(vector, [1, 0])).toBe(1);
    expect(cosineSimilarity(new Float32Array([0, 1]), [1, 0])).toBe(0);
  });
});
