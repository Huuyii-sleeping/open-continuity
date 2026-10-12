import type { CaptureCheckpoint, ConversationThread } from "../capture/types.js";

export interface CaptureThreadReference {
  id: string;
  cwd: string;
  updatedAt: string;
  ephemeral: boolean;
}

export interface CaptureListResult {
  threads: CaptureThreadReference[];
  pages: number;
  truncated: boolean;
}

export interface CaptureReadOptions {
  /** Durable source-specific position from a previous successful import. */
  checkpoint?: CaptureCheckpoint;
}

export interface CaptureAdapter {
  readonly id: string;
  connect(): Promise<void>;
  listThreads(input?: { pageSize?: number; maxThreads?: number }): Promise<CaptureListResult>;
  readThread(threadId: string, options?: CaptureReadOptions): Promise<ConversationThread>;
  close(): Promise<void>;
}

export interface InjectionAdapterStatus {
  valid: boolean;
  installed: boolean;
  detail?: string;
}

export interface InjectionAdapterInstallResult extends InjectionAdapterStatus {
  changed: boolean;
}

export interface InjectionAdapterUninstallResult extends InjectionAdapterStatus {
  changed: boolean;
}

export interface InjectionAdapter<TOutput> {
  readonly id: string;
  readonly hookEvent: string;
  emptyOutput(): TOutput;
  renderContext(context: string): TOutput;
  check(): InjectionAdapterStatus;
  install(): InjectionAdapterInstallResult;
  uninstall(): InjectionAdapterUninstallResult;
}
