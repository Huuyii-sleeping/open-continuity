/** Staged model lifecycle port. Concrete inference packages remain outside Core. */
export interface LocalModelSession<Input, Output> {
  run(input: Input): Promise<Output>;
  /** Must release the owned process/resources, not merely abandon the caller's wait. */
  close(): Promise<void>;
}
export interface LocalModelOwnerPolicy { maxPending: number; idleMs: number; }
