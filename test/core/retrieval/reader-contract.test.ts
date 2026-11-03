import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";
import { CandidateRetrieval } from "../../../src/core/retrieval/candidates.js";
import type { CandidateReader, CandidateReaderSet, CandidateRetrievalRequest, CandidateSearchResult } from "../../../src/core/retrieval/contracts.js";
import { ExactCandidateRetriever } from "../../../src/core/retrieval/retrievers/exact.js";
import { StructuredCandidateRetriever } from "../../../src/core/retrieval/retrievers/structured.js";
import { FullTextCandidateRetriever } from "../../../src/core/retrieval/retrievers/full-text.js";
import { MemoryService } from "../../../src/core/application/memory-service.js";
import { RetrievalPipeline } from "../../../src/core/retrieval/pipeline.js";
import type { MemoryStore } from "../../../src/core/memory/contracts.js";
import { InMemoryStore } from "../../../src/storage/inmemory/store.js";
import { candidateRuntime } from "../../../evals/candidates/runtime.js";
import type { Backend } from "../../../evals/baseline/evaluator.js";
import { candidateSearchInputSchema } from "../../../src/core/retrieval/contracts.js";

const actor = { userId: "fictional-modular-user", agentId: "fictional-reader" };
const empty = (channel: CandidateSearchResult["channel"]): CandidateSearchResult => ({ channel, status: "ok", hits: [], truncated: false, ordering: "updated_at_id", implementation: "structured_lookup" });
const turn = () => new Promise<void>(resolve => setImmediate(resolve));

describe("independent candidate readers", () => {
  it("keeps channel policies local and does not mutate the original request", async () => {
    const input = { ...actor, query: "fictional needle", scope: "user" as const, includePrivate: false, lexicalFallback: true };
    const exact = vi.fn(async (request: CandidateRetrievalRequest) => { expect(request).not.toHaveProperty("lexicalFallback"); request.includePrivate = true; return empty("exact"); });
    const structured = vi.fn(async (request: CandidateRetrievalRequest) => { expect(request.includePrivate).toBe(false); expect(request).not.toHaveProperty("lexicalFallback"); return empty("structured"); });
    const fullText = vi.fn(async (request: CandidateRetrievalRequest) => { expect(request).toMatchObject({ includePrivate: false, lexicalFallback: true }); return empty("full_text"); });
    await new ExactCandidateRetriever(exact).retrieve(input);
    await new StructuredCandidateRetriever(structured).retrieve(input);
    await new FullTextCandidateRetriever(fullText).retrieve(input);
    expect(input.includePrivate).toBe(false);
    expect([exact.mock.calls.length, structured.mock.calls.length, fullText.mock.calls.length]).toEqual([1, 1, 1]);
  });
  it("only executes selected readers, preserving requested order and failure boundaries", async () => {
    const exact = vi.fn(async () => empty("exact")), structured = vi.fn(async () => empty("structured"));
    const full_text = vi.fn(async () => { throw new Error("fictional full-text failure"); });
    const pipeline = new CandidateRetrieval({ exact, structured, full_text });
    expect((await pipeline.retrieve(actor, ["structured", "exact"])).map(batch => batch.channel)).toEqual(["structured", "exact"]);
    expect(full_text).not.toHaveBeenCalled();
    exact.mockClear(); structured.mockClear();
    await expect(pipeline.retrieve(actor, ["full_text", "exact"])).rejects.toThrow("fictional full-text failure");
    expect(exact).not.toHaveBeenCalled();
  });
  it("rejects a reader that returns another channel", async () => {
    const wrong = new ExactCandidateRetriever(async () => empty("full_text"));
    await expect(wrong.retrieve(actor)).rejects.toMatchObject({ code: "STORAGE_ERROR" });
  });
  it("registers one reader independently and rejects missing channels before reading", async () => {
    const full_text = vi.fn(async () => empty("full_text"));
    const pipeline = new CandidateRetrieval({ full_text });
    await expect(pipeline.retrieve(actor)).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
    expect(full_text).not.toHaveBeenCalled();
    expect((await pipeline.retrieve(actor, ["full_text"])).map(batch => batch.channel)).toEqual(["full_text"]);
  });
  it("reports only configured readers and rejects an unavailable pipeline channel at construction", () => {
    const base = new InMemoryStore();
    const full_text = vi.fn(async () => empty("full_text"));
    const source = { recall: base.recall.bind(base), candidateReaders: { full_text } };
    expect(() => new RetrievalPipeline(source)).toThrow(expect.objectContaining({ code: "VALIDATION_ERROR" }));
    const pipeline = new RetrievalPipeline(source, { channels: ["full_text"] });
    expect(pipeline.capabilityPolicy()).toMatchObject({ scored: true, channels: ["full_text"] });
    expect(full_text).not.toHaveBeenCalled();
  });
  it("preserves legacy wrapper overrides while allowing an explicit reader-only source", async () => {
    const store = new InMemoryStore();
    const search = vi.spyOn(store, "searchCandidates");
    await new CandidateRetrieval(store).retrieve(actor, ["exact"]);
    expect(search).toHaveBeenCalledTimes(1);
    search.mockClear();
    await new CandidateRetrieval(store.candidateReaders).retrieve(actor, ["exact"]);
    expect(search).not.toHaveBeenCalled();
  });
});

for (const backend of ["sqlite", "inmemory", "json", "postgres-pg-mem"] satisfies Backend[]) {
  it(`${backend}: native readers match the legacy facade and preserve eligibility before top-K`, async () => {
    const fixture = await candidateRuntime(fileURLToPath(new URL("../../../", import.meta.url)), backend);
    const { store, service } = fixture;
    const native: MemoryStore = {
      appendRemember: store.appendRemember.bind(store), appendForget: store.appendForget.bind(store),
      recall: store.recall.bind(store), history: store.history.bind(store), candidateReaders: store.candidateReaders,
      ...(store.list ? { list: store.list.bind(store) } : {}),
      ...(store.readFactGroup ? { readFactGroup: store.readFactGroup.bind(store) } : {}),
      ...(store.lexicalFallbackVersion ? { lexicalFallbackVersion: store.lexicalFallbackVersion } : {}),
    };
    const readerService = new MemoryService(native, { candidateLimit: 1 }, { defaultTokenBudget: 4096, maxTokenBudget: 4096, maxMemories: 10, requireUserConfirmed: true });
    try {
      expect(store.candidateReaders).toBeDefined();
      const write = (key: string, extra: Partial<Parameters<MemoryService["remember"]>[0]> = {}) => service.remember({ ...actor, key, value: "fictional needle", kind: "decision", userConfirmed: true, idempotencyKey: "fictional-" + key, ...extra });
      await write("approved");
      await write("private", { sensitivity: "private" });
      await write("pending", { userConfirmed: false });
      await write("user", { userId: "fictional-other-user" });
      await write("agent", { scope: "agent", agentId: "fictional-other-agent" });
      await write("task", { scope: "task", taskId: "fictional-other-task" });
      for (const channel of ["exact", "structured", "full_text"] as const) {
        const request = candidateSearchInputSchema.parse({ ...actor, channel, query: channel === "exact" ? "approved" : "needle", kind: "decision", limit: 1, requireUserConfirmed: true });
        const legacy = await store.searchCandidates!(request);
        const { channel: _channel, ...input } = request;
        expect(await store.candidateReaders![channel]!(input)).toEqual(legacy);
      }
      const context = await readerService.context({ ...actor, query: "needle" });
      expect(context.items.map(item => item.key)).toEqual(["approved"]);
      const query = await readerService.query({ ...actor, query: "needle", strategy: "direct" });
      expect(query.answer!.statements.map(item => item.key)).toEqual(["approved"]);
      expect(readerService.retrievalCapabilityPolicy().scored).toBe(true);
    } finally { await readerService.close(); await fixture.close(); }
  });
}

it("reader-only stores keep timed-out work in pending-read capacity until settlement", async () => {
  let finish!: (result: CandidateSearchResult) => void;
  const pending = new Promise<CandidateSearchResult>(resolve => { finish = resolve; });
  const base = new InMemoryStore();
  const fullText = vi.fn<CandidateReader>().mockReturnValueOnce(pending).mockResolvedValue(empty("full_text"));
  const candidateReaders: CandidateReaderSet = { ...base.candidateReaders, full_text: fullText };
  const store: MemoryStore = { appendRemember: base.appendRemember.bind(base), appendForget: base.appendForget.bind(base), recall: base.recall.bind(base), history: base.history.bind(base), candidateReaders };
  const service = new MemoryService(store, { channels: ["full_text"] }, undefined, undefined, { defaultTimeoutMs: 10, maxPendingReads: 1 });
  try {
    await expect(service.recall({ ...actor, query: "fictional slow" })).rejects.toMatchObject({ code: "READ_TIMEOUT" });
    expect(service.readRuntimeStatus()).toMatchObject({ activeRequests: 0, pendingReads: 1 });
    await expect(service.recall({ ...actor, query: "fictional slow" })).rejects.toMatchObject({ code: "RUNTIME_BUSY" });
    expect(fullText).toHaveBeenCalledTimes(1);
    finish(empty("full_text")); await turn();
    expect(service.readRuntimeStatus().pendingReads).toBe(0);
    expect((await service.recall({ ...actor, query: "fictional slow" })).memories).toEqual([]);
  } finally { finish(empty("full_text")); await turn(); await service.close(); }
});
