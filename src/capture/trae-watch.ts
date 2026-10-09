import type { CaptureSyncResult } from "./types.js";
import { acquireCaptureLock } from "./capture-lock.js";
import { syncTraeCapture } from "./trae-capture-service.js";

export interface TraeCaptureWatchOptions {
  limit: number;
  intervalMs: number;
  once?: boolean;
  maxThreads?: number;
  retryLimit?: number;
  retryDelayMs?: number;
  onCycle?: (result: CaptureSyncResult & { inboxPath: string; threadIds: string[]; cycle: number }) => void;
}

export async function watchTraeCapture(input: TraeCaptureWatchOptions, env: NodeJS.ProcessEnv = process.env, signal?: AbortSignal): Promise<{ cycles: number; last?: CaptureSyncResult & { inboxPath: string; threadIds: string[]; cycle: number } }> {
  const lock = acquireCaptureLock(env);
  let cycles = 0;
  let last: CaptureSyncResult & { inboxPath: string; threadIds: string[]; cycle: number } | undefined;
  try {
    while (!signal?.aborted) {
      let attempt = 0;
      while (true) {
        try {
          const result = { ...(await syncTraeCapture({ limit: input.limit, maxThreads: input.maxThreads, lock: false }, env)), cycle: cycles + 1 };
          cycles += 1;
          last = result;
          input.onCycle?.(result);
          break;
        } catch (error) {
          attempt += 1;
          if (attempt > (input.retryLimit ?? 3) || signal?.aborted) throw error;
          await new Promise<void>((resolve) => setTimeout(resolve, Math.min(input.retryDelayMs ?? 1000, 30_000) * 2 ** (attempt - 1)));
        }
      }
      if (input.once) break;
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, input.intervalMs);
        signal?.addEventListener("abort", () => { clearTimeout(timer); resolve(); }, { once: true });
      });
    }
    return { cycles, ...(last ? { last } : {}) };
  } finally { lock.release(); }
}
