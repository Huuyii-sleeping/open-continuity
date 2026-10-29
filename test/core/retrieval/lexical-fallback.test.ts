import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it, vi } from "vitest";
import { fallbackTerms, oneWordEdit, verifySpelling, wordTrigrams } from "../../../src/core/retrieval/full-text/lexical-fallback.js";
import { CandidateRetrieval } from "../../../src/core/retrieval/candidates.js";
import { MemoryService } from "../../../src/core/application/memory-service.js";
import { SqliteMemoryStore } from "../../../src/storage/sqlite/sqlite-memory-store.js";
import { rankEvidence } from "../../../src/core/retrieval/ranking.js";
import { buildHttpApp } from "../../../src/http/app.js";
import { candidateRuntime } from "../../../evals/candidates/runtime.js";

const actor = { userId: "fictional-spelling-user", agentId: "fictional-spelling-reader" };
const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { vi.useRealTimers(); for (const cleanup of cleanups.splice(0)) await cleanup(); });
function runtime(enabled = true) {
  const directory = mkdtempSync(join(tmpdir(), "oc-fictional-spelling-")), path = join(directory, "fictional.db");
  const store = new SqliteMemoryStore(path), service = new MemoryService(store, { lexicalFallback: enabled ? "latin_one_edit" : "off" },
    { defaultTokenBudget: 1024, maxTokenBudget: 4096, maxMemories: 20, requireUserConfirmed: true });
  cleanups.push(async () => { await service.close(); rmSync(directory, { recursive: true, force: true }); });
  return { store, service, path };
}
const write = (service: MemoryService, key: string, value: string) => service.remember({ ...actor, key, value, kind: "decision", userConfirmed: true, idempotencyKey: key });

describe("bounded spelling verification", () => {
  it.each([["nebulra", "nebula", "delete"], ["nebul", "nebula", "insert"], ["nebulx", "nebula", "substitute"], ["concsie", "concise", "transpose"]] as const)("classifies %s without semantic expansion", (query, word, edit) => {
    expect(oneWordEdit(query, word)).toBe(edit);
  });
  it("rejects equality, multiple edits, nonwords and unsupported queries", () => {
    for (const [a, b] of [["nebula", "nebula"], ["nexxla", "nebula"], ["nebula", "nebula7"]]) expect(oneWordEdit(a!, b!)).toBeNull();
    for (const query of ["中文改写", "nebula-7", "v12345", "abcd", "a b c d e f g h nebula", "x".repeat(33)]) expect(fallbackTerms(query)).toBeNull();
    expect(fallbackTerms("NEBULRA nebUlra CHECKPOINT")).toEqual(["nebulra", "checkpoint"]);
    // Conservative index probing is not exhaustive for all valid one-edits.
    expect(oneWordEdit("abxde", "abcde")).toBe("substitute");
    expect(wordTrigrams("abxde").filter(trigram => wordTrigrams("abcde").includes(trigram))).toEqual([]);
  });
  it("requires every other token exactly, not substrings, and enforces text budgets", () => {
    expect(verifySpelling(["nebulra", "checkpoint"], "fictional", '"nebula checkpoint"').correction?.matchedToken).toBe("nebula");
    expect(verifySpelling(["nebulra", "checkpoint"], "fictional", '"nebula checkpoints"').correction).toBeNull();
    expect(verifySpelling(["nebulra"], "fictional", '"nebula ' + "word ".repeat(257) + '"').boundedOut).toBe(true);
    expect(verifySpelling(["nebulra"], "fictional", "nebula " + "x".repeat(65536)).boundedOut).toBe(true);
  });
});

describe("SQLite optional spelling retrieval", () => {
  it.each(["nebulra", "nebla", "nebulx"])("recovers %s with explicit correction, score and actual citation", async query => {
    const { store, service } = runtime(); await write(service, "fictional-target", "nebula checkpoint");
    const batch = store.searchCandidates({ ...actor, query: query + " checkpoint", channel: "full_text", lexicalFallback: true });
    expect(batch).toMatchObject({ implementation: "sqlite_one_edit_fallback", lexicalFallback: { used: true, reason: "literal_miss" } });
    expect(batch.hits[0]).toMatchObject({ channelRank: 1, rankMeaning: "relevance", score: { model: "token_edit_distance", value: 1 }, match: { correction: { queryToken: query, matchedToken: "nebula" } } });
    const answer = await service.query({ ...actor, query: query + " checkpoint" });
    expect(answer.answer).toMatchObject({ status: "evidence_ready", statements: [{ value: "nebula checkpoint" }], citations: [{ memoryId: batch.hits[0]!.memory.id, version: 1 }] });
    const broken = structuredClone(batch); broken.hits[0]!.match.correction!.matchedToken = "unrelated";
    expect(() => rankEvidence([broken], { rrfK: 60, exactPrecedence: true, fusion: "rrf" })).toThrow(expect.objectContaining({ code: "STORAGE_ERROR" }));
  });
  it("recovers the existing transpose challenge without inventing a semantic answer", async () => {
    const { service } = runtime(); await write(service, "fictional-style", "concise project summaries");
    const result = await service.context({ ...actor, query: "concsie project summaries" });
    expect(result.items.map(item => item.value)).toEqual(["concise project summaries"]);
    expect(result.items[0]!.retrieval?.evidence?.[0]?.match.correction?.edit).toBe("transpose");
    expect((await service.context({ ...actor, query: "brief project summaries" })).items).toEqual([]);
  });
  it("never expands literal hits, and default OFF preserves the original response", async () => {
    const { store, service } = runtime(false);
    await write(service, "fictional-corrected", "nebula checkpoint");
    expect((await service.recall({ ...actor, query: "nebulra checkpoint" })).memories).toEqual([]);
    await write(service, "fictional-literal", "nebulra checkpoint");
    const input = { ...actor, query: "nebulra checkpoint", channel: "full_text" as const };
    const literal = store.searchCandidates(input), enabled = store.searchCandidates({ ...input, lexicalFallback: true });
    expect(enabled.hits).toEqual(literal.hits);
    expect(enabled.lexicalFallback).toMatchObject({ used: false, reason: "literal_hit", inspected: 0 });
    expect(enabled.hits.map(hit => hit.memory.key)).toEqual(["fictional-literal"]);
    expect(service.retrievalCapabilityPolicy()).toMatchObject({ lexicalFallbackSupported: true, lexicalFallback: null });
  });
  it("rejects extra missing anchors, short/numeric edits and unsupported input", async () => {
    const { store, service } = runtime(); await write(service, "fictional", "nebula checkpoint at v12345 abcde");
    for (const query of ["nebulra checkpoints", "nebula ax", "nebula v12346", "中文 nebula", "abxde"]) {
      expect(store.searchCandidates({ ...actor, query, channel: "full_text", lexicalFallback: true }).hits).toEqual([]);
    }
    expect(store.searchCandidates({ ...actor, query: "nebulra at", channel: "full_text", lexicalFallback: true }).hits).toHaveLength(1);
  });
  it("filters all identity boundaries before the probe and confirmation before strict endpoints", async () => {
    const { store, service } = runtime();
    await write(service, "fictional-visible", "nebula checkpoint");
    for (let n = 0; n < 110; n++) await service.remember({ ...actor, userId: "fictional-other-user", key: `fictional-other-${n}`, value: "nebula checkpoint", kind: "decision", userConfirmed: true, idempotencyKey: `other-${n}` });
    const hidden = [
      { sensitivity: "private" as const }, { scope: "agent" as const, agentId: "fictional-other-agent" },
      { scope: "task" as const, taskId: "fictional-other-task" }, { userConfirmed: false },
    ];
    for (const [n, fields] of hidden.entries()) await service.remember({ ...actor, key: `fictional-hidden-${n}`, value: "nebula checkpoint", kind: "decision", userConfirmed: true, ...fields, idempotencyKey: `hidden-${n}` });
    const batch = store.searchCandidates({ ...actor, query: "nebulra checkpoint", channel: "full_text", lexicalFallback: true, requireUserConfirmed: true });
    expect(batch.hits.map(hit => hit.memory.key)).toEqual(["fictional-visible"]);
    expect(batch.lexicalFallback?.inspected).toBe(1);
    expect((await service.context({ ...actor, query: "nebulra checkpoint" })).items.map(item => item.key)).toEqual(["fictional-visible"]);
    expect((await service.query({ ...actor, query: "nebulra checkpoint" })).answer?.citations).toHaveLength(1);
    expect((await service.recall({ ...actor, query: "nebulra checkpoint" })).memories.map(item => item.key).sort()).toEqual(["fictional-hidden-3", "fictional-visible"]);
    expect(store.searchCandidates({ ...actor, scope: "agent", query: "nebulra checkpoint", channel: "full_text", lexicalFallback: true }).hits).toEqual([]);
  });
  it("keeps native fixed-window prefix, stable tie-breaks and policy-bound pagination", async () => {
    const { store, service } = runtime();
    vi.useFakeTimers({ toFake: ["Date"] }); vi.setSystemTime(new Date("2031-01-01T00:00:00Z"));
    for (let n = 0; n < 4; n++) await write(service, `fictional-${n}`, "nebula checkpoint");
    vi.useRealTimers();
    const request = { ...actor, query: "nebulra checkpoint", channel: "full_text" as const, lexicalFallback: true };
    const all = store.searchCandidates({ ...request, limit: 100 });
    expect(store.searchCandidates({ ...request, limit: 2 }).hits).toEqual(all.hits.slice(0, 2));
    expect(all.hits.map(hit => hit.memory.id)).toEqual(all.hits.map(hit => hit.memory.id).sort().reverse());
    const first = await service.recall({ ...actor, query: request.query, limit: 2 });
    const second = await service.recall({ ...actor, query: request.query, limit: 2, cursor: first.nextCursor! });
    expect([...first.memories, ...second.memories].map(item => item.id)).toEqual(all.hits.map(hit => hit.memory.id));
    const off = new MemoryService(store);
    await expect(off.recall({ ...actor, query: request.query, limit: 2, cursor: first.nextCursor! })).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
  });
  it("bounds inspected rows and rejects oversized evidence rather than truncating it", async () => {
    const { store, service } = runtime();
    await write(service, "fictional-large", "nebula checkpoint " + "x".repeat(65536));
    await write(service, "fictional-tokens", "nebula checkpoint " + "filler ".repeat(257));
    const request = { ...actor, query: "nebulra checkpoint", channel: "full_text" as const, lexicalFallback: true };
    const bounded = store.searchCandidates(request);
    expect(bounded.hits).toEqual([]); expect(bounded.lexicalFallback).toMatchObject({ boundedOut: 2, truncated: true });
    for (let n = 0; n < 130; n++) await write(service, `fictional-noise-${n}`, "nebulous checkpoint");
    const capped = store.searchCandidates(request);
    expect(capped.lexicalFallback).toMatchObject({ inspected: 100, truncated: true });
    expect(capped.hits).toEqual([]);
  });
  it("preserves CAS, idempotency, exact versions, forget and explicit conflict refusal", async () => {
    const { service } = runtime();
    const receipt = await write(service, "fictional-version", "nebula checkpoint old");
    expect((await write(service, "fictional-version", "nebula checkpoint old")).event.id).toBe(receipt.event.id);
    await expect(service.remember({ ...actor, key: "fictional-version", value: "nebula checkpoint new", kind: "decision", userConfirmed: true, expectedVersion: 0, idempotencyKey: "fictional-bad-cas" })).rejects.toMatchObject({ code: "VERSION_CONFLICT" });
    const latest = await service.remember({ ...actor, key: "fictional-version", value: "nebula checkpoint new", kind: "decision", userConfirmed: true, expectedVersion: 1, idempotencyKey: "fictional-new" });
    expect((await service.query({ ...actor, query: "nebulra checkpoint" })).answer?.citations[0]).toMatchObject({ version: 2, sourceEventId: latest.event.id });
    await service.forget({ ...actor, memoryId: latest.current.id });
    expect((await service.context({ ...actor, query: "nebulra checkpoint" })).items).toEqual([]);
    for (const value of ["nebula checkpoint red", "nebula checkpoint blue"]) await service.remember({ ...actor, key: "fictional-" + value, value, kind: "decision", userConfirmed: true, expectedVersion: 0, fact: { group: "fictional-checkpoint" }, idempotencyKey: value });
    const conflict = await service.query({ ...actor, query: "nebulra checkpoint" });
    expect(conflict.answer?.status).toBe("abstain"); expect(conflict.steps.flatMap(step => step.factReview?.omitted ?? [])).toHaveLength(2);
  });
  it("keeps storage errors as errors", async () => {
    const { store, path } = runtime(); const db = new DatabaseSync(path); db.exec("DROP TABLE memories_fts"); db.close();
    expect(() => store.searchCandidates({ ...actor, query: "nebulra", channel: "full_text", lexicalFallback: true })).toThrow(expect.objectContaining({ code: "STORAGE_ERROR" }));
  });
  it("exposes supported/enabled separately and public extras cannot enable the policy", async () => {
    const { service } = runtime(); await write(service, "fictional", "nebula checkpoint");
    const app = buildHttpApp(service); await app.ready();
    try {
      expect((await app.inject({ method: "GET", url: "/v1/capabilities" })).json().retrieval.lexicalFallback).toMatchObject({ supported: true, enabled: true, version: "latin-one-edit-v1", limits: { probeLimit: 100 } });
      const result = await app.inject({ method: "POST", url: "/v1/query", payload: { ...actor, query: "nebulra checkpoint" } });
      expect(result.statusCode).toBe(200); expect(result.json().contextPack.items[0].retrieval.evidence[0].match.correction.matchedToken).toBe("nebula");
    } finally { await app.close(); }
    const off = runtime(false); await write(off.service, "fictional", "nebula checkpoint");
    const offApp = buildHttpApp(off.service); await offApp.ready();
    try {
      expect((await offApp.inject({ method: "GET", url: "/v1/capabilities" })).json().retrieval.lexicalFallback).toMatchObject({ supported: true, enabled: false });
      const ignored = await offApp.inject({ method: "POST", url: "/v1/query", payload: { ...actor, query: "nebulra checkpoint", lexicalFallback: true } });
      expect(ignored.statusCode).toBe(200); expect(ignored.json().answer.status).toBe("abstain");
    } finally { await offApp.close(); }
  });
  it.each(["inmemory", "json", "postgres-pg-mem"] as const)("does not claim SQLite fallback on %s", async backend => {
    const fixture = await candidateRuntime(resolve("."), backend); cleanups.push(fixture.close);
    const service = new MemoryService(fixture.store, { lexicalFallback: "latin_one_edit" });
    expect(service.retrievalCapabilityPolicy()).toMatchObject({ lexicalFallbackSupported: false, lexicalFallback: null });
    await write(service, "fictional", "nebula checkpoint");
    expect((await service.recall({ ...actor, query: "nebulra checkpoint" })).memories).toEqual([]);
  });
  it("omits the OFF field entirely for strict legacy custom stores", async () => {
    const searchCandidates = vi.fn(request => {
      expect(request).not.toHaveProperty("lexicalFallback");
      return { ...runtime(false).store.searchCandidates(request) };
    });
    await new CandidateRetrieval({ searchCandidates }).retrieve({ ...actor, query: "absent" });
    expect(searchCandidates).toHaveBeenCalledTimes(3);
  });
  it("does not advertise enabled fallback when full_text is disabled", () => {
    const { store } = runtime();
    const service = new MemoryService(store, { channels: ["exact"], lexicalFallback: "latin_one_edit" });
    expect(service.retrievalCapabilityPolicy()).toMatchObject({ lexicalFallbackSupported: true, lexicalFallback: null });
  });
});
