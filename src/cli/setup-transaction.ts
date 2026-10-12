import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { OpenContinuityError } from "../shared/errors.js";

export type SetupStepStatus = "planned" | "applied" | "verified" | "failed";
export interface SetupStep { name: string; status: SetupStepStatus; detail?: string; }
export interface SetupTransactionSummary {
  phase: "complete" | "rolled_back";
  steps: SetupStep[];
  rollback: Array<{ name: string; ok: boolean; detail?: string }>;
}

export interface FileSnapshot {
  path: string;
  existed: boolean;
  content?: Buffer;
  mode?: number;
}

export function snapshotFile(path: string): FileSnapshot {
  if (!existsSync(path)) return { path, existed: false };
  return { path, existed: true, content: readFileSync(path), mode: statSync(path).mode & 0o777 };
}

export function restoreFile(snapshot: FileSnapshot): void {
  if (!snapshot.existed) {
    if (existsSync(snapshot.path)) unlinkSync(snapshot.path);
    return;
  }
  mkdirSync(dirname(snapshot.path), { recursive: true, mode: 0o700 });
  const temporary = `${snapshot.path}.${process.pid}.rollback.tmp`;
  writeFileSync(temporary, snapshot.content!, { mode: snapshot.mode ?? 0o600 });
  renameSync(temporary, snapshot.path);
  chmodSync(snapshot.path, snapshot.mode ?? 0o600);
}

export function restoreObject<T extends object>(target: T, snapshot: T): void {
  for (const key of Object.keys(target) as Array<keyof T>) delete target[key];
  Object.assign(target, structuredClone(snapshot));
}

export class SetupTransaction {
  private readonly steps: SetupStep[];
  private readonly rollbackActions: Array<{ name: string; action: () => void | Promise<void> }> = [];

  constructor(readonly agent: string, plan: string[]) {
    this.steps = plan.map((name) => ({ name, status: "planned" }));
  }

  addRollback(name: string, action: () => void | Promise<void>): void {
    this.rollbackActions.push({ name, action });
  }

  async apply<T>(name: string, action: () => T | Promise<T>, detail?: (result: T) => string | undefined): Promise<T> {
    const step = this.steps.find((entry) => entry.name === name);
    if (!step) throw new Error(`Setup step was not planned: ${name}`);
    try {
      const result = await action();
      step.status = "applied";
      step.detail = detail?.(result);
      return result;
    } catch (error) {
      step.status = "failed";
      step.detail = error instanceof Error ? error.message : String(error);
      throw error;
    }
  }

  verified(name: string, detail?: string): void {
    const step = this.steps.find((entry) => entry.name === name);
    if (!step) throw new Error(`Setup step was not planned: ${name}`);
    step.status = "verified";
    step.detail = detail;
  }

  complete(): SetupTransactionSummary {
    return { phase: "complete", steps: this.steps.map((step) => ({ ...step })), rollback: [] };
  }

  async rollbackAndWrap(error: unknown): Promise<OpenContinuityError> {
    const rollback: SetupTransactionSummary["rollback"] = [];
    for (const entry of [...this.rollbackActions].reverse()) {
      try {
        await entry.action();
        rollback.push({ name: entry.name, ok: true });
      } catch (rollbackError) {
        rollback.push({ name: entry.name, ok: false, detail: rollbackError instanceof Error ? rollbackError.message : String(rollbackError) });
      }
    }
    const message = error instanceof Error ? error.message : String(error);
    return new OpenContinuityError(
      "CONFIGURATION_ERROR",
      `Setup for ${this.agent} failed and compensation was attempted: ${message}`,
      500,
      { transaction: { phase: "rolled_back", steps: this.steps, rollback } satisfies SetupTransactionSummary },
    );
  }
}
