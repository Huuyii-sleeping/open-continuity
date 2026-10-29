import { performance } from "node:perf_hooks";
import { OpenContinuityError } from "../../shared/errors.js";
import type { ReadStage, ReadStageReceipt } from "./contracts.js";
export class ReadTimeoutError extends OpenContinuityError {
  constructor() { super("READ_TIMEOUT", "Read execution budget exhausted", 504); }
}
export class ReadDeadline {
  private readonly deadline: number;
  private stopped = false;
  readsStarted = 0;
  readonly stages = new Map<ReadStage, ReadStageReceipt>();
  constructor(timeoutMs: number, private readonly clock: () => number = performance.now.bind(performance)) {
    if (!Number.isFinite(timeoutMs) || timeoutMs < 1 || timeoutMs > 30000) throw new OpenContinuityError("VALIDATION_ERROR", "Invalid read deadline", 400);
    this.deadline = this.clock() + timeoutMs;
  }
  expired() { return this.stopped || this.clock() >= this.deadline; }
  stop() { this.stopped = true; }
  check() { if (this.expired()) throw new ReadTimeoutError(); }
  async wait<T>(start: () => T | Promise<T>): Promise<T> {
    this.check();
    // Check after invoking the thunk too: a synchronous operation may block past its deadline.
    const operation = Promise.resolve().then(() => { this.check(); return start(); });
    let timer: NodeJS.Timeout | undefined;
    try {
      const result = await Promise.race([operation, new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new ReadTimeoutError()), Math.max(0, this.deadline - this.clock()));
      })]);
      this.check();
      return result;
    } catch (error) {
      if (error instanceof ReadTimeoutError) this.stop();
      throw error;
    } finally { if (timer) clearTimeout(timer); }
  }
}
