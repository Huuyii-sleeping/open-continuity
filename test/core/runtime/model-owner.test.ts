import { afterEach, describe, expect, it, vi } from "vitest";
import { LocalModelOwner } from "../../../src/core/runtime/model-owner.js";

function deferred<T>() {
  let resolve!: (value: T) => void, reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
afterEach(() => vi.useRealTimers());

describe("staged local model lifecycle", () => {
  it("coalesces startup and holds a bounded capacity during loading", async () => {
    const ready = deferred<{ run(input: number): Promise<number>; close(): Promise<void> }>();
    const load = vi.fn(() => ready.promise);
    const owner = new LocalModelOwner(load, { maxPending: 2, idleMs: 100 });
    const a = owner.run(1), b = owner.run(2);
    await expect(owner.run(3)).rejects.toMatchObject({ code: "RUNTIME_BUSY" });
    await Promise.resolve(); expect(load).toHaveBeenCalledTimes(1);
    ready.resolve({ run: async value => value * 2, close: async () => {} });
    expect(await Promise.all([a, b])).toEqual([2, 4]); await owner.close();
  });
  it("does not release unfinished work when an external caller stops waiting", async () => {
    const work = deferred<number>();
    const owner = new LocalModelOwner(async () => ({ run: () => work.promise, close: async () => {} }), { maxPending: 1, idleMs: 100 });
    const operation = owner.run(1);
    await Promise.race([operation, Promise.resolve("caller-deadline")]);
    expect(owner.snapshot().pending).toBe(1);
    await expect(owner.run(2)).rejects.toMatchObject({ code: "RUNTIME_BUSY" });
    work.resolve(42); expect(await operation).toBe(42); expect(owner.snapshot().pending).toBe(0); await owner.close();
  });
  it("retires idle resources and reloads for a later request", async () => {
    vi.useFakeTimers(); const close = vi.fn(async () => {}), load = vi.fn(async () => ({ run: async (value: number) => value, close }));
    const owner = new LocalModelOwner(load, { maxPending: 1, idleMs: 100 });
    await owner.run(1); await vi.advanceTimersByTimeAsync(100);
    expect(close).toHaveBeenCalledTimes(1); expect(owner.snapshot().loaded).toBe(false);
    await owner.run(2); expect(load).toHaveBeenCalledTimes(2); await owner.close();
  });
  it("resets idle time when used and never closes active work", async () => {
    vi.useFakeTimers(); const work = deferred<number>(), close = vi.fn(async () => {});
    let calls = 0;
    const owner = new LocalModelOwner(async () => ({ run: async () => ++calls === 1 ? 1 : work.promise, close }), { maxPending: 1, idleMs: 100 });
    await owner.run(0); await vi.advanceTimersByTimeAsync(50); const active = owner.run(0);
    await vi.advanceTimersByTimeAsync(200); expect(close).not.toHaveBeenCalled();
    work.resolve(2); await active; await vi.advanceTimersByTimeAsync(99); expect(close).not.toHaveBeenCalled();
    await owner.close();
  });
  it("drains work before explicit close and rejects later admission", async () => {
    const work = deferred<number>(), close = vi.fn(async () => {});
    const owner = new LocalModelOwner(async () => ({ run: () => work.promise, close }), { maxPending: 1, idleMs: 100 });
    const operation = owner.run(1), closed = owner.close();
    await expect(owner.run(2)).rejects.toMatchObject({ code: "RUNTIME_BUSY" }); expect(close).not.toHaveBeenCalled();
    work.resolve(3); await operation; await closed; expect(close).toHaveBeenCalledTimes(1); expect(owner.close()).toBe(closed);
  });
  it("releases failed startup capacity and permits retry", async () => {
    let attempts = 0;
    const owner = new LocalModelOwner(async () => {
      if (++attempts === 1) throw new Error("fictional-load-failure");
      return { run: async (value: number) => value, close: async () => {} };
    }, { maxPending: 1, idleMs: 100 });
    await expect(owner.run(1)).rejects.toThrow("fictional-load-failure"); expect(owner.snapshot().pending).toBe(0);
    expect(await owner.run(2)).toBe(2); await owner.close();
  });
  it("keeps failed close fail closed rather than loading another model", async () => {
    vi.useFakeTimers(); const load = vi.fn(async () => ({ run: async () => 1, close: async () => { throw new Error("fictional-close-failure"); } }));
    const owner = new LocalModelOwner(load, { maxPending: 1, idleMs: 10 });
    await owner.run(0); await vi.advanceTimersByTimeAsync(10);
    expect(owner.snapshot().poisoned).toBe(true);
    await expect(owner.run(0)).rejects.toMatchObject({ code: "RUNTIME_BUSY" });
    await expect(owner.close()).rejects.toThrow("fictional-close-failure"); expect(load).toHaveBeenCalledTimes(1);
  });
  it("validates lifecycle policy without installing an inference package", () => {
    const load = async () => ({ run: async (value: number) => value, close: async () => {} });
    for (const policy of [{ maxPending: 0, idleMs: 1 }, { maxPending: 1, idleMs: 0 }, { maxPending: 1.5, idleMs: 1 }, { maxPending: 1, idleMs: Infinity }]) {
      expect(() => new LocalModelOwner(load, policy)).toThrow("lifecycle policy");
    }
  });
});
