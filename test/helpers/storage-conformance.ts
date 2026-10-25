import { describe, expect, it, vi } from "vitest";
import { MemoryService } from "../../src/core/memory-service.js";
import { encodeCursor } from "../../src/core/cursor.js";
import type { MemoryStore } from "../../src/core/memory-store.js";
import type { MemoryRepository, StructuredMemoryInput } from "../../src/core/storage-contract.js";
import { storageFingerprint } from "../../src/core/storage-contract.js";
import { recallInputSchema, type RememberInput } from "../../src/shared/types.js";

export interface StorageRuntime {
  store: MemoryStore & MemoryRepository;
  service: MemoryService;
  reopen?: () => Promise<MemoryService>;
}
const USER = "fictional-contract-user";
const READER = "fictional-reader";
const query = { userId: USER, agentId: READER };
function write(key: string, extra: Partial<RememberInput> = {}): RememberInput {
  return { userId: USER, agentId: "fictional-writer", key, value: { fictional: key }, kind: "user_fact", userConfirmed: true, idempotencyKey: `fictional-write-${key}`, ...extra };
}

export function storageConformance(label: string, create: () => Promise<StorageRuntime>, limitations: { pgMemReservedJsonKeys?: boolean } = {}) {
  describe(`${label}: storage-contract-v1`, () => {
    it("separates structured listing from legacy text lookup", async () => {
      const { service, store } = await create();
      await service.remember(write("one"));
      const { query: _textQuery, ...structuredInput } = recallInputSchema.parse(query);
      expect((await store.list(structuredInput)).memories).toHaveLength(1);
      // Exercise the runtime boundary with invalid input without claiming it is a valid typed request.
      const invalidInput: unknown = { ...structuredInput, query: "text" };
      await expect(Promise.resolve().then(() => Reflect.apply(store.list, store, [invalidInput]))).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
    });

    it("isolates user, agent, task, private and kind filters; confirmation remains consumer policy", async () => {
      const { service } = await create();
      await service.remember(write("public"));
      await service.remember(write("unconfirmed", { userConfirmed: false }));
      await service.remember(write("private", { sensitivity: "private" }));
      await service.remember(write("other-user", { userId: "fictional-other-user" }));
      await service.remember(write("agent", { scope: "agent" }));
      await service.remember(write("task-a", { scope: "task", taskId: "fictional-task-a" }));
      await service.remember(write("task-b", { scope: "task", taskId: "fictional-task-b" }));
      const keys = async (extra = {}) => (await service.recall({ ...query, limit: 100, ...extra })).memories.map((item) => item.key).sort();
      expect(await keys()).toEqual(["public", "unconfirmed"]);
      expect(await keys({ taskId: "fictional-task-a" })).toEqual(["public", "task-a", "unconfirmed"]);
      expect(await keys({ scope: "task", taskId: "fictional-task-a" })).toEqual(["task-a"]);
      expect(await keys({ scope: "agent", agentId: "fictional-writer" })).toEqual(["agent"]);
      expect(await keys({ includePrivate: true })).toEqual(["private", "public", "unconfirmed"]);
      expect(await keys({ kind: "decision" })).toEqual([]);
      expect(await keys({ key: "public" })).toEqual(["public"]);
      expect((await service.history({ ...query, limit: 100 })).events.map((event) => event.key).sort()).toEqual(["public", "unconfirmed"]);
    });

    it("uses collision-free identities including separators in user/task/agent keys", async () => {
      const { service } = await create();
      const a = await service.remember(write("gamma", { scope: "task", taskId: "alpha:beta", idempotencyKey: "task-a" }));
      const b = await service.remember(write("beta:gamma", { scope: "task", taskId: "alpha", idempotencyKey: "task-b" }));
      expect(a.current.id).not.toBe(b.current.id);
      expect((await service.recall({ ...query, scope: "task", taskId: "alpha:beta" })).memories.map((item) => item.key)).toEqual(["gamma"]);
      const c = await service.remember(write("c", { scope: "agent", agentId: "a:b", idempotencyKey: "agent-a" }));
      const d = await service.remember(write("b:c", { scope: "agent", agentId: "a", idempotencyKey: "agent-b" }));
      expect(c.current.id).not.toBe(d.current.id);
      const e = await service.remember(write("k", { userId: "fictional:user:-", idempotencyKey: "b" }));
      const f = await service.remember(write("user:-:k", { userId: "fictional", idempotencyKey: "a:b" }));
      expect(e.current.id).not.toBe(f.current.id);
      await service.remember(write("idem-a", { userId: "fictional:a", idempotencyKey: "b" }));
      expect((await service.remember(write("user:-:k", { userId: "fictional", idempotencyKey: "a:b" }))).duplicate).toBe(true);
    });

    it("replays the original receipt after later updates/forget without restoring state", async () => {
      const { service } = await create();
      const input = write("versioned", { expectedVersion: 0 });
      const first = await service.remember(input);
      const second = await service.remember(write("versioned", { value: { latest: true }, idempotencyKey: "second", expectedVersion: 1 }));
      expect(second.current).toMatchObject({ id: first.current.id, version: 2, supersedes: { eventId: first.event.id, version: 1 } });
      expect(await service.remember(input)).toEqual({ ...first, duplicate: true });
      expect((await service.recall(query)).memories[0]!.version).toBe(2);
      await service.forget({ ...query, memoryId: first.current.id });
      expect((await service.remember(input)).current.version).toBe(1);
      expect((await service.recall(query)).memories).toEqual([]);
      expect((await service.history({ ...query, memoryId: first.current.id })).events).toHaveLength(3);
    });

    it("retains merged receipts and forget idempotency when reopened or replayed", async () => {
      const runtime = await create();
      const first = await runtime.service.remember(write("reopened", { value: { keep: true }, expectedVersion: 0 }));
      const patch = write("reopened", { value: { added: true }, writeMode: "merge", expectedVersion: 1, idempotencyKey: "fictional-reopen-merge" });
      const merged = await runtime.service.remember(patch);
      const forgotten = await runtime.service.forget({ ...query, memoryId: first.current.id });
      if (!runtime.reopen) throw new Error("Conformance fixture must support reopen or ledger replay");
      const reopened = await runtime.reopen();
      expect(await reopened.remember(patch)).toEqual({ ...merged, duplicate: true });
      expect((await reopened.recall(query)).memories).toEqual([]);
      expect((await reopened.history(query)).events).toHaveLength(3);
      await expect(reopened.remember(write("reopened", { idempotencyKey: forgotten.event.idempotencyKey }))).rejects.toMatchObject({ code: "IDEMPOTENCY_CONFLICT" });
      expect((await reopened.remember(write("reopened", { expectedVersion: 0, idempotencyKey: "fictional-new-lifecycle" }))).current).toMatchObject({ version: 1 });
      expect((await reopened.recall(query)).memories[0]!.id).not.toBe(first.current.id);
    });

    it("rejects changed idempotent requests and stale CAS without changing state/history", async () => {
      const { service } = await create();
      const input = write("guarded");
      const first = await service.remember(input);
      for (const change of [{ value: false }, { metadata: { different: true } }, { userConfirmed: false }, { agentId: READER }]) {
        await expect(service.remember({ ...input, ...change })).rejects.toMatchObject({ code: "IDEMPOTENCY_CONFLICT" });
      }
      await expect(service.remember({ ...input, idempotencyKey: "stale", expectedVersion: 0 })).rejects.toMatchObject({ code: "VERSION_CONFLICT" });
      expect((await service.recall(query)).memories[0]).toEqual(first.current);
      expect((await service.history(query)).events).toHaveLength(1);
      expect((await service.remember({ ...input, idempotencyKey: "stale", expectedVersion: 1 })).current.version).toBe(2);
    });

    it("preserves nested JSON during merge", async () => {
      const { service } = await create();
      await service.remember(write("nested", { value: { nested: { keep: true, replace: 1 } } }));
      const input = write("nested", { value: { nested: { replace: 2 }, array: [1, 2] }, expectedVersion: 1, writeMode: "merge", idempotencyKey: "nested-patch" });
      expect((await service.remember(input)).current.value).toEqual({ nested: { keep: true, replace: 2 }, array: [1, 2] });
      expect((await service.remember(input)).duplicate).toBe(true);
    });

    it.skipIf(limitations.pgMemReservedJsonKeys)("preserves prototype-named JSON keys (pg-mem cannot verify; real PostgreSQL required)", async () => {
      const { service } = await create();
      const base = JSON.parse('{"__proto__":{"fictional":"base"},"nested":{"keep":true,"replace":1}}') as unknown;
      await service.remember(write("merge", { value: base }));
      const patch = JSON.parse('{"__proto__":{"added":true},"nested":{"replace":2},"array":[1,2]}') as unknown;
      const input = write("merge", { value: patch, expectedVersion: 1, writeMode: "merge", idempotencyKey: "merge-patch" });
      const receipt = await service.remember(input);
      expect(receipt.current.value).toEqual(JSON.parse('{"__proto__":{"fictional":"base","added":true},"nested":{"keep":true,"replace":2},"array":[1,2]}'));
      expect((await service.remember(input)).duplicate).toBe(true);
    });

    it("returns detached snapshots and does not retain caller-owned values/metadata", async () => {
      const { service, store } = await create();
      const input = write("snapshot", { value: { nested: { count: 1 } }, metadata: { fictional: { count: 1 } } });
      const pending = service.remember(input);
      (input.value as { nested: { count: number } }).nested.count = 99;
      (input.metadata!.fictional as { count: number }).count = 99;
      const receipt = await pending;
      expect(receipt.current.value).toEqual({ nested: { count: 1 } });
      (receipt.current.value as { nested: { count: number } }).nested.count = 77;
      receipt.event.metadata = { overwritten: true };
      const read = await service.recall(query);
      (read.memories[0]!.value as { nested: { count: number } }).nested.count = 66;
      const events = await service.history(query);
      events.events[0]!.key = "tampered";
      const again = await store.list(recallInputSchema.parse(query) as StructuredMemoryInput);
      expect(again.memories[0]!.value).toEqual({ nested: { count: 1 } });
      expect((await service.history(query)).events[0]).toMatchObject({ key: "snapshot", metadata: { fictional: { count: 1 } } });
    });

    it("paginates without duplicates/omissions and allows changing only page size", async () => {
      const { service } = await create();
      for (let index = 0; index < 7; index++) await service.remember(write(`page-${index}`));
      const all = (await service.recall({ ...query, limit: 100 })).memories;
      const selected = [];
      let cursor: string | undefined;
      do {
        const page = await service.recall({ ...query, limit: cursor ? 3 : 2, cursor });
        selected.push(...page.memories);
        cursor = page.nextCursor ?? undefined;
      } while (cursor);
      expect(selected.map((item) => item.id)).toEqual(all.map((item) => item.id));
      expect(new Set(selected.map((item) => item.id)).size).toBe(7);
      const history = await service.history({ ...query, limit: 100 });
      const first = await service.history({ ...query, limit: 2 });
      const rest = await service.history({ ...query, limit: 100, cursor: first.nextCursor! });
      expect([...first.events, ...rest.events].map((event) => event.id)).toEqual(history.events.map((event) => event.id));
    });

    it("binds current/history cursors to filters and rejects unbound legacy cursors", async () => {
      const { service } = await create();
      for (const key of ["a", "b", "c"]) await service.remember(write(key));
      const first = await service.recall({ ...query, limit: 1 });
      for (const extra of [{ userId: "another-user" }, { agentId: "another-agent" }, { includePrivate: true }, { kind: "decision" as const }, { scope: "agent" as const }, { key: "a" }, { taskId: "fictional-task" }]) {
        await expect(service.recall({ ...query, ...extra, cursor: first.nextCursor! })).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
      }
      const legacy = encodeCursor("memory", first.memories[0]!.updatedAt, first.memories[0]!.id);
      await expect(service.recall({ ...query, cursor: legacy })).rejects.toMatchObject({ code: "VALIDATION_ERROR", details: { reason: "legacy_cursor_restart_required" } });
      const history = await service.history({ ...query, limit: 1 });
      for (const extra of [{ userId: "another-user" }, { agentId: "another-agent" }, { includePrivate: true }, { memoryId: first.memories[0]!.id }, { taskId: "another-task" }]) {
        await expect(service.history({ ...query, ...extra, cursor: history.nextCursor! })).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
      }
      await expect(service.history({ ...query, cursor: first.nextCursor! })).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
    });

    it("rejects malformed current/history cursors with a stable validation error", async () => {
      const { service } = await create();
      await service.remember(write("cursor-data"));
      for (const cursor of ["!invalid!", "a".repeat(4097), Buffer.from("null").toString("base64url"), Buffer.from('{}').toString("base64url"), encodeCursor("memory", "not-a-date", "fictional-id")]) {
        await expect(service.recall({ ...query, cursor })).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
        await expect(service.history({ ...query, cursor })).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
      }
    });

    it("enforces eligibility even when the caller constructs a matching cursor fingerprint", async () => {
      const { service } = await create();
      await service.remember(write("visible"));
      await service.remember(write("private-cursor", { sensitivity: "private" }));
      await service.remember(write("foreign-user-cursor", { userId: "fictional-foreign" }));
      await service.remember(write("foreign-agent-cursor", { scope: "agent" }));
      await service.remember(write("foreign-task-cursor", { scope: "task", taskId: "fictional-foreign-task" }));
      const id = "00000000-0000-0000-0000-000000000000";
      const timestamp = "9999-01-01T00:00:00.000Z";
      const cursor = encodeCursor("memory", timestamp, id, storageFingerprint(recallInputSchema.parse(query), "memory"));
      expect((await service.recall({ ...query, cursor })).memories.map((memory) => memory.key)).toEqual(["visible"]);
      const historyCursor = encodeCursor("event", timestamp, id, storageFingerprint({ ...recallInputSchema.parse(query), memoryId: undefined }, "event"));
      expect((await service.history({ ...query, cursor: historyCursor })).events.map((event) => event.key)).toEqual(["visible"]);
    });

    it("paginates equal timestamps with an id tie-break for current state and history", async () => {
      const { service } = await create();
      vi.useFakeTimers({ toFake: ["Date"] });
      vi.setSystemTime(new Date("2030-01-01T00:00:00.000Z"));
      try {
        for (const key of ["equal-a", "equal-b", "equal-c", "equal-d"]) await service.remember(write(key));
        const all = (await service.recall({ ...query, limit: 100 })).memories;
        expect(new Set(all.map((memory) => memory.updatedAt)).size).toBe(1);
        const first = await service.recall({ ...query, limit: 2 });
        const second = await service.recall({ ...query, limit: 2, cursor: first.nextCursor! });
        expect([...first.memories, ...second.memories].map((memory) => memory.id)).toEqual(all.map((memory) => memory.id));
        const events = await service.history({ ...query, limit: 100 });
        const eventPage = await service.history({ ...query, limit: 2 });
        const eventRest = await service.history({ ...query, limit: 2, cursor: eventPage.nextCursor! });
        expect([...eventPage.events, ...eventRest.events].map((event) => event.id)).toEqual(events.events.map((event) => event.id));
      } finally { vi.useRealTimers(); }
    });

    it("matches literal percent/underscore rather than treating input as SQL wildcards", async () => {
      const { service } = await create();
      await service.remember(write("percent", { value: "fictional 50% complete" }));
      await service.remember(write("plain", { value: "fictional 500 complete" }));
      await service.remember(write("underscore", { value: "fictional a_b literal" }));
      expect((await service.recall({ ...query, query: "50%" })).memories.map((item) => item.key)).toEqual(["percent"]);
      expect((await service.recall({ ...query, query: "a_b" })).memories.map((item) => item.key)).toEqual(["underscore"]);
    });

    it("enforces forget permissions while retaining authorized audit history", async () => {
      const { service } = await create();
      const secret = await service.remember(write("secret", { sensitivity: "private" }));
      await expect(service.forget({ ...query, memoryId: secret.current.id })).rejects.toMatchObject({ code: "MEMORY_NOT_FOUND" });
      await expect(service.forget({ ...query, userId: "another-user", includePrivate: true, memoryId: secret.current.id })).rejects.toMatchObject({ code: "MEMORY_NOT_FOUND" });
      const receipt = await service.forget({ ...query, includePrivate: true, memoryId: secret.current.id });
      expect((await service.history({ ...query, includePrivate: true })).events).toHaveLength(2);
      expect((await service.history(query)).events).toEqual([]);
      await expect(service.remember(write("secret", { idempotencyKey: receipt.event.idempotencyKey }))).rejects.toMatchObject({ code: "IDEMPOTENCY_CONFLICT" });
    });

    it("never replays a forget event as a remember receipt, including a null value", async () => {
      const { service } = await create();
      const original = write("forgotten-null", { value: null, agentId: READER });
      const remembered = await service.remember(original);
      const forgotten = await service.forget({ ...query, memoryId: remembered.current.id });
      await expect(service.remember({ ...original, idempotencyKey: forgotten.event.idempotencyKey })).rejects.toMatchObject({ code: "IDEMPOTENCY_CONFLICT" });
      expect((await service.recall(query)).memories).toEqual([]);
      expect((await service.history(query)).events).toHaveLength(2);
    });

    it("rejects cyclic/sparse values before any state or audit write", async () => {
      const { service } = await create();
      const cycle: Record<string, unknown> = {}; cycle.self = cycle;
      for (const value of [cycle, Array(2), undefined, Number.NaN]) await expect(service.remember(write("invalid", { value }))).rejects.toThrow();
      expect((await service.recall(query)).memories).toEqual([]);
      expect((await service.history(query)).events).toEqual([]);
      const receipt = await service.remember(write("invalid", { value: -0 }));
      expect(Object.is(receipt.current.value, 0)).toBe(true);
    });
  });
}
