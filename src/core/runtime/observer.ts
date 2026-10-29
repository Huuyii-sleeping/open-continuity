import type { ReadRuntimeObserver, ReadRuntimeReceipt } from "./contracts.js";
export function emitReadReceipt(observer: ReadRuntimeObserver | undefined, receipt: ReadRuntimeReceipt): void {
  // Observability is optional, synchronous and metadata-only; observer failures must not alter results.
  try {
    const pending: unknown = observer?.(Object.freeze(receipt));
    // A caller may supply an async callback despite the void contract. Observe its rejection too.
    if (pending && typeof pending === "object" && "then" in pending) void Promise.resolve(pending).catch(() => { });
  } catch { /* best-effort observer */ }
}
