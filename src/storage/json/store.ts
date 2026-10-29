import { dispatchCandidateSearch } from "../../core/retrieval/readers.js";
import type { BuiltinSyncCandidateReaders, CandidateRetrievalRequest } from "../../core/retrieval/contracts.js";
import type { RetrievalChannel } from "../../shared/types.js";
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname } from "node:path";
import { randomUUID } from "node:crypto";
import { OpenContinuityError } from "../../shared/errors.js";
import type { HistoryResult, MemoryEvent, ParsedHistoryInput, ParsedRecallInput, ParsedRememberInput, RecallResult } from "../../shared/types.js";
import type { MemoryStore, MemoryReceiptLike } from "../../core/memory/contracts.js";
import { InMemoryStore } from "../inmemory/store.js";
import { assertStructuredInput, type MemoryRepository, type StructuredMemoryInput } from "../../core/memory/storage-contract.js";
import { parseCandidateSearch, type CandidateSearchRequest, type CandidateSearchResult, type CandidateSearchStore } from "../../core/retrieval/contracts.js";
import { parseFactGroupRequest, type FactGroupRequest } from "../../core/facts/contracts.js";
import { decodeEventLedger, encodeEventLedger } from "../../core/memory/event-ledger.js";

/**
 * A small local event ledger for separate MCP stdio processes. It is intended
 * for a single machine prototype; a database-backed store should replace it
 * when multiple machines or high write concurrency are needed.
 */
export class JsonFileStore implements MemoryStore, MemoryRepository, CandidateSearchStore {
  readonly candidateReaders: BuiltinSyncCandidateReaders = Object.freeze<BuiltinSyncCandidateReaders>({
    exact: input => this.readCandidates("exact", input),
    structured: input => this.readCandidates("structured", input),
    full_text: input => this.readCandidates("full_text", input),
  });
  private current: InMemoryStore;
  private readonly lockWaitMs = 5000;

  constructor(private readonly filePath = homedir() + "/.open-continuity/memories.json") {
    this.current = this.load();
  }

  appendRemember(input: ParsedRememberInput): MemoryReceiptLike {
    return this.withWriteLock(() => this.current.appendRemember(input));
  }

  appendForget(userId: string, agentId: string, memoryId: string, taskId?: string, includePrivate?: boolean): MemoryReceiptLike {
    return this.withWriteLock(() => this.current.appendForget(userId, agentId, memoryId, taskId, includePrivate));
  }

  recall(input: ParsedRecallInput): RecallResult {
    this.refresh();
    return this.current.recall(input);
  }

  list(input: StructuredMemoryInput): RecallResult {
    assertStructuredInput(input);
    this.refresh();
    return this.current.list(input);
  }

  history(input: ParsedHistoryInput): HistoryResult {
    this.refresh();
    return this.current.history(input);
  }

  searchCandidates(request: CandidateSearchRequest): CandidateSearchResult {
    return dispatchCandidateSearch(request, this.candidateReaders);
  }
  readFactGroup(input: FactGroupRequest) {
    parseFactGroupRequest(input);
    this.refresh();
    return this.current.readFactGroup(input);
  }

  private readCandidates(channel: RetrievalChannel, input: CandidateRetrievalRequest): CandidateSearchResult {
    parseCandidateSearch({ ...input, channel });
    if (channel === "dense") throw new OpenContinuityError("VALIDATION_ERROR", "JSON has no Dense reader", 400);
    this.refresh();
    const result = this.current.candidateReaders[channel](input);
    return { ...result, implementation: result.implementation === "inmemory_compatibility" ? "json_compatibility" : result.implementation };
  }

  private refresh(): void {
    this.current = this.load();
  }

  private load(): InMemoryStore {
    try { return new InMemoryStore(this.readEvents()); }
    catch { throw new OpenContinuityError("STORAGE_ERROR", "Unable to read a valid memory ledger", 500); }
  }

  private readEvents(): MemoryEvent[] {
    if (!existsSync(this.filePath)) return [];
    try {
      return decodeEventLedger(JSON.parse(readFileSync(this.filePath, "utf8")));
    } catch (error) {
      if (error instanceof OpenContinuityError) throw error;
      throw new OpenContinuityError("STORAGE_ERROR", "Unable to read the memory store", 500);
    }
  }

  private persist(): void {
    mkdirSync(dirname(this.filePath), { recursive: true });
    const temporaryPath = this.filePath + "." + process.pid + "." + randomUUID() + ".tmp";
    try {
      const ledger = encodeEventLedger(this.current.allEvents());
      writeFileSync(temporaryPath, JSON.stringify(ledger, null, 2) + "\n", { encoding: "utf8", mode: 0o600, flag: "wx" });
      renameSync(temporaryPath, this.filePath);
    } finally {
      if (existsSync(temporaryPath)) unlinkSync(temporaryPath);
    }
  }

  private withWriteLock<T>(operation: () => T): T {
    mkdirSync(dirname(this.filePath), { recursive: true });
    const lockPath = this.filePath + ".lock";
    const startedAt = Date.now();
    let lockFd: number | undefined;
    while (lockFd === undefined) {
      try {
        lockFd = openSync(lockPath, "wx");
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST" || Date.now() - startedAt >= this.lockWaitMs) {
          throw new OpenContinuityError("STORAGE_ERROR", "Unable to acquire the memory ledger lock", 500);
        }
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
      }
    }
    try {
      this.refresh();
      const result = operation();
      this.persist();
      return result;
    } catch (error) {
      if (error instanceof OpenContinuityError) throw error;
      throw new OpenContinuityError("STORAGE_ERROR", "Unable to persist the memory ledger", 500);
    } finally {
      closeSync(lockFd);
      unlinkSync(lockPath);
    }
  }
}
