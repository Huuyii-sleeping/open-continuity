import { afterEach, expect, it, vi } from "vitest";
import { MemoryService } from "../../../src/core/application/memory-service.js";
import { InMemoryStore } from "../../../src/storage/inmemory/store.js";
import type { MemoryStore } from "../../../src/core/memory/contracts.js";
import { capabilitiesWithServiceSupport } from "../../../src/core/application/capabilities.js";
import { developmentCapabilities } from "../../../src/core/runtime/profile.js";
import { validateHandoffDraft } from "../../../src/core/memory/handoff/review.js";
import { renderHandoffResume } from "../../../src/core/memory/handoff/render.js";

const actor = { userId: "fictional-handoff-user", agentId: "fictional-writer" }, taskId = "fictional-offline-export";
const input = { ...actor, taskId, summary: "Fictional JSON export is complete; CSV remains", sensitivity: "public" as const,
  decisions: ["Keep all processing offline"], nextActions: ["Confirm timezone, then implement CSV"], blockedBy: ["Timezone remains unconfirmed"], artifacts: ["fictional/schema.json"] };
const services: MemoryService[] = [];
const service = () => { const s = new MemoryService(); services.push(s); return s; };
afterEach(async () => { vi.useRealTimers(); for (const s of services.splice(0)) await s.closeGracefully(); });
it("prepares without creating memory, then binds explicit confirmation and resumes across agents", async () => {
  const s = service(), draft = await s.prepareHandoff(input);
  expect((await s.history({ ...actor, taskId })).events).toHaveLength(0);
  expect(await s.resumeHandoff({ ...actor, taskId })).toMatchObject({ status: "not_found" });
  const result = await s.confirmHandoff({ ...actor, draft, reviewedFingerprint: draft.fingerprint, userConfirmed: true });
  expect(result.memory.current).toMatchObject({ scope: "task", taskId, userConfirmed: true, version: 1 });
  expect(result.memory.event.metadata.openContinuityHandoffReview).toMatchObject({ draftFingerprint: draft.fingerprint, expectedSnapshot: { version: 0 } });
  const resumed = await s.resumeHandoff({ ...actor, agentId: "fictional-reader", taskId });
  expect(resumed.capsule).toMatchObject({ nextActions: input.nextActions, blockedBy: input.blockedBy });
  expect(renderHandoffResume(resumed)).toContain("memoryId");
});
it("rejects changed content, wrong fingerprint, wrong actor and absent confirmation without writes", async () => {
  const s = service(), draft = await s.prepareHandoff(input), valid = { ...actor, draft, reviewedFingerprint: draft.fingerprint, userConfirmed: true as const };
  const changed = structuredClone(draft); changed.input.nextActions = ["Invented action"];
  await expect(s.confirmHandoff({ ...valid, draft: changed })).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
  await expect(s.confirmHandoff({ ...valid, reviewedFingerprint: "a".repeat(64) })).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
  await expect(s.confirmHandoff({ ...valid, userId: "fictional-other" })).rejects.toMatchObject({ code: "FORBIDDEN" });
  await expect(s.confirmHandoff({ ...valid, agentId: "fictional-other" })).rejects.toMatchObject({ code: "FORBIDDEN" });
  const unconfirmed: unknown = { ...valid, userConfirmed: false }; await expect(Reflect.apply(s.confirmHandoff, s, [unconfirmed])).rejects.toThrow();
  expect((await s.history({ ...actor, taskId })).events).toHaveLength(0);
});
it("defaults drafts to private and requires explicit visibility review", async () => {
  const s = service(), { sensitivity: _sensitivity, ...privateInput } = input;
  const draft = await s.prepareHandoff(privateInput);
  expect(draft.input.sensitivity).toBe("private");
  await s.confirmHandoff({ ...actor, draft, reviewedFingerprint: draft.fingerprint, userConfirmed: true });
  expect(await s.resumeHandoff({ ...actor, taskId, agentId: "fictional-reader" })).toMatchObject({ status: "not_found", capsule: null });
  expect(await s.resumeHandoff({ ...actor, taskId, includePrivate: true })).toMatchObject({ status: "ready" });
});
it("expires review independently from the stored capsule and never revives missing or expired handoffs", async () => {
  vi.useFakeTimers(); vi.setSystemTime(new Date("2030-01-01T00:00:00Z")); const s = service(), draft = await s.prepareHandoff(input);
  vi.setSystemTime(new Date("2030-01-02T00:00:01Z")); expect(() => validateHandoffDraft(draft)).toThrow(/expired/);
  await expect(s.confirmHandoff({ ...actor, draft, reviewedFingerprint: draft.fingerprint, userConfirmed: true })).rejects.toThrow();
  expect(await s.resumeHandoff({ ...actor, taskId })).toMatchObject({ status: "not_found" });
});
it("advertises actual atomic store support and rejects unsupported legacy stores before I/O", async () => {
  const backing = new InMemoryStore(); const read = vi.fn(backing.recall.bind(backing));
  const legacy: MemoryStore = { appendRemember: backing.appendRemember.bind(backing), appendForget: backing.appendForget.bind(backing), history: backing.history.bind(backing), recall: read };
  const s = new MemoryService(legacy); services.push(s);
  expect(capabilitiesWithServiceSupport(developmentCapabilities(), s).handoff).toMatchObject({ reviewedDrafts: false, reviewVersion: null });
  await expect(s.prepareHandoff(input)).rejects.toMatchObject({ code: "VALIDATION_ERROR" }); expect(read).not.toHaveBeenCalled();
  expect(capabilitiesWithServiceSupport(developmentCapabilities(), service()).handoff).toMatchObject({ reviewedDrafts: true, reviewVersion: "handoff-review-v1" });
});
it("does not resume unconfirmed or misbound task state as an approved handoff", async () => {
  const s = service(); await s.remember({ ...actor, key: `handoff:${taskId}`, taskId, scope: "task", kind: "task_state", userConfirmed: false,
    value: { schemaVersion: "1.0", taskId, summary: "Unconfirmed fictional state", status: "ready", decisions: [], nextActions: [], artifacts: [], blockedBy: [], sourceAgentId: actor.agentId }, idempotencyKey: "fictional-unconfirmed" });
  expect(await s.resumeHandoff({ ...actor, taskId })).toMatchObject({ status: "not_found", memory: null });
  await s.remember({ ...actor, key: `handoff:${taskId}`, taskId, scope: "task", kind: "task_state", userConfirmed: true,
    value: { schemaVersion: "1.0", taskId, summary: "Fictional wrong source", status: "ready", decisions: [], nextActions: [], artifacts: [], blockedBy: [], sourceAgentId: "fictional-fake-source" }, idempotencyKey: "fictional-misbound" });
  await expect(s.resumeHandoff({ ...actor, taskId })).rejects.toMatchObject({ code: "STORAGE_ERROR" });
  await s.remember({ ...actor, key: `handoff:${taskId}`, taskId, scope: "task", kind: "task_state", userConfirmed: true,
    value: {}, idempotencyKey: "fictional-malformed" });
  await expect(s.resumeHandoff({ ...actor, taskId })).rejects.toMatchObject({ code: "STORAGE_ERROR" });
});
