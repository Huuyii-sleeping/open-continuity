import { OpenContinuityError } from "../../shared/errors.js";
import type { LocalModelOwnerPolicy, LocalModelSession } from "./model-contracts.js";

/** Opt-in lifecycle primitive; default factories never load a model. */
export class LocalModelOwner<Input, Output> {
  private session?: LocalModelSession<Input, Output>;
  private loading?: Promise<LocalModelSession<Input, Output>>;
  private retiring?: Promise<void>;
  private idleTimer?: ReturnType<typeof setTimeout>;
  private readonly work = new Set<Promise<Output>>();
  private stopped = false;
  private poisoned = false;
  private closePromise?: Promise<void>;
  private readonly policy: Readonly<LocalModelOwnerPolicy>;

  constructor(private readonly load: () => Promise<LocalModelSession<Input, Output>>, policy: LocalModelOwnerPolicy) {
    if (!Number.isInteger(policy.maxPending) || policy.maxPending < 1 || policy.maxPending > 16
      || !Number.isInteger(policy.idleMs) || policy.idleMs < 1 || policy.idleMs > 86_400_000) {
      throw new OpenContinuityError("VALIDATION_ERROR", "Invalid local model lifecycle policy", 400);
    }
    this.policy = Object.freeze({ ...policy });
  }

  snapshot() {
    return { pending: this.work.size, loaded: Boolean(this.session), loading: Boolean(this.loading), retiring: Boolean(this.retiring), stopped: this.stopped, poisoned: this.poisoned };
  }

  run(input: Input): Promise<Output> {
    if (this.stopped || this.poisoned || this.retiring || this.work.size >= this.policy.maxPending) {
      return Promise.reject(new OpenContinuityError("RUNTIME_BUSY", "Local model is unavailable or at capacity", 503));
    }
    this.clearIdle();
    const operation = Promise.resolve().then(async () => {
      if (!this.session) {
        if (!this.loading) {
          this.loading = Promise.resolve().then(this.load).then(session => {
            this.session = session;
            return session;
          }).finally(() => { this.loading = undefined; });
        }
        await this.loading;
      }
      return this.session!.run(input);
    });
    this.work.add(operation);
    // Only underlying settlement releases admission, including when a caller times out elsewhere.
    void operation.then(() => this.settled(operation), () => this.settled(operation));
    return operation;
  }

  close(): Promise<void> {
    if (this.closePromise) return this.closePromise;
    this.stopped = true; this.clearIdle();
    this.closePromise = Promise.allSettled([...this.work]).then(async () => {
      if (this.retiring) await this.retiring;
      else await this.retire();
    });
    return this.closePromise;
  }

  private settled(operation: Promise<Output>) {
    this.work.delete(operation);
    if (this.stopped || this.poisoned || this.work.size || !this.session) return;
    this.idleTimer = setTimeout(() => {
      this.idleTimer = undefined;
      if (!this.work.size && !this.stopped) void this.retire().catch(() => { this.poisoned = true; });
    }, this.policy.idleMs);
    this.idleTimer.unref();
  }

  private clearIdle() { if (this.idleTimer) clearTimeout(this.idleTimer); this.idleTimer = undefined; }

  private retire(): Promise<void> {
    if (this.retiring) return this.retiring;
    if (!this.session) return Promise.resolve();
    const session = this.session;
    const retirement = Promise.resolve().then(() => session.close()).then(() => { this.session = undefined; })
      .catch(error => { this.poisoned = true; throw error; });
    this.retiring = retirement;
    void retirement.then(() => { this.retiring = undefined; }, () => { /* Failed ownership release remains fail closed. */ });
    return retirement;
  }
}
