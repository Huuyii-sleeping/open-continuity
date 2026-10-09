import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import { MemoryService } from "../core/memory-service.js";
import { SqliteMemoryStore } from "../sqlite/sqlite-memory-store.js";
import { extractMemoryCandidates } from "./candidate-extractor.js";
import { redactSensitiveText, sanitizeConversationItem } from "./sensitivity.js";
import type { CaptureCheckpoint, CaptureCheckpointStatus, CaptureSyncResult, ConversationItem, ConversationThread, MemoryCandidate } from "./types.js";

type Row = Record<string, unknown>;

function parseCandidate(row: Row): MemoryCandidate {
  return {
    id: String(row.id), source: "trae", threadId: String(row.thread_id), turnId: String(row.turn_id), itemId: String(row.item_id),
    kind: row.kind as MemoryCandidate["kind"], key: String(row.memory_key), value: String(row.value), evidence: String(row.evidence),
    rationale: String(row.rationale), confidence: Number(row.confidence), sensitivity: row.sensitivity as MemoryCandidate["sensitivity"],
    captureQuality: row.capture_quality as MemoryCandidate["captureQuality"], status: row.status as MemoryCandidate["status"],
    createdAt: String(row.created_at), reviewedAt: row.reviewed_at == null ? undefined : String(row.reviewed_at),
    memoryEventId: row.memory_event_id == null ? undefined : String(row.memory_event_id),
  };
}

function parseCheckpoint(row: Row): CaptureCheckpoint {
  return {
    source: "trae",
    threadId: String(row.thread_id),
    threadUpdatedAt: String(row.thread_updated_at),
    lastTurnId: row.last_turn_id == null ? undefined : String(row.last_turn_id),
    lastItemId: row.last_item_id == null ? undefined : String(row.last_item_id),
    lastItemCount: Number(row.last_item_count),
    syncedAt: String(row.synced_at),
  };
}

export class ConversationInbox {
  private readonly database: DatabaseSync;
  private closed = false;

  constructor(readonly databasePath: string) {
    mkdirSync(dirname(databasePath), { recursive: true, mode: 0o700 });
    this.database = new DatabaseSync(databasePath);
    this.database.exec("PRAGMA journal_mode = WAL");
    this.database.exec("PRAGMA synchronous = NORMAL");
    this.migrate();
  }

  importThreads(threads: ConversationThread[]): CaptureSyncResult {
    this.assertOpen();
    const result: CaptureSyncResult = { source: "trae", threadsSeen: threads.length, threadsImported: 0, turnsImported: 0, itemsImported: 0, candidatesCreated: 0, skippedEphemeral: 0, skippedUnchanged: 0, sensitiveItemsRedacted: 0, candidatesBlockedSensitive: 0 };
    this.database.exec("BEGIN IMMEDIATE");
    try {
      for (const thread of threads) {
        if (thread.ephemeral) { result.skippedEphemeral += 1; continue; }
        const syncedAt = new Date().toISOString();
        const preview = redactSensitiveText(thread.preview).text;
        const existing = this.get("SELECT updated_at FROM capture_threads WHERE source = ? AND thread_id = ?", [thread.source, thread.id]);
        this.run("INSERT INTO capture_threads (source, thread_id, session_id, cwd, cli_version, preview, created_at, updated_at, synced_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT (source, thread_id) DO UPDATE SET session_id = excluded.session_id, cwd = excluded.cwd, cli_version = excluded.cli_version, preview = excluded.preview, created_at = excluded.created_at, updated_at = excluded.updated_at, synced_at = excluded.synced_at",
          [thread.source, thread.id, thread.sessionId, thread.cwd, thread.cliVersion, preview, thread.createdAt, thread.updatedAt, syncedAt]);
        if (!existing || existing.updated_at !== thread.updatedAt) result.threadsImported += 1;
        for (const turn of thread.turns) {
          const turnExisting = this.get("SELECT 1 FROM capture_turns WHERE source = ? AND thread_id = ? AND turn_id = ?", [thread.source, thread.id, turn.id]);
          this.run("INSERT INTO capture_turns (source, thread_id, turn_id, status, capture_quality, started_at, completed_at) VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT (source, thread_id, turn_id) DO UPDATE SET status = excluded.status, capture_quality = excluded.capture_quality, started_at = excluded.started_at, completed_at = excluded.completed_at",
            [thread.source, thread.id, turn.id, turn.status, turn.quality, turn.startedAt ?? null, turn.completedAt ?? null]);
          if (!turnExisting) result.turnsImported += 1;
          for (const [ordinal, rawItem] of turn.items.entries()) {
            const sanitized = sanitizeConversationItem(rawItem);
            const item = sanitized.item;
            if (sanitized.matches.length) result.sensitiveItemsRedacted = (result.sensitiveItemsRedacted ?? 0) + 1;
            const itemExisting = this.get("SELECT 1 FROM capture_items WHERE source = ? AND thread_id = ? AND turn_id = ? AND item_id = ?", [thread.source, thread.id, turn.id, item.id]);
            this.run("INSERT INTO capture_items (source, thread_id, turn_id, item_id, ordinal, item_type, phase, raw_type, content) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT (source, thread_id, turn_id, item_id) DO UPDATE SET ordinal = excluded.ordinal, item_type = excluded.item_type, phase = excluded.phase, raw_type = excluded.raw_type, content = excluded.content",
              [thread.source, thread.id, turn.id, item.id, ordinal, item.type, item.phase ?? null, item.rawType, JSON.stringify(item)]);
            if (!itemExisting) result.itemsImported += 1;
            const candidates = extractMemoryCandidates({ threadId: thread.id, turnId: turn.id, quality: turn.quality, item });
            if (rawItem.sensitive || sanitized.matches.length) result.candidatesBlockedSensitive = (result.candidatesBlockedSensitive ?? 0) + (rawItem.type === "user_message" ? 1 : 0);
            result.candidatesCreated += this.insertCandidates(candidates);
          }
        }
        const lastTurn = thread.turns.at(-1);
        const allItems = thread.turns.flatMap((turn) => turn.items);
        const lastItem = allItems.at(-1);
        this.run("INSERT INTO capture_checkpoints (source, thread_id, thread_updated_at, last_turn_id, last_item_id, last_item_count, synced_at) VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT (source, thread_id) DO UPDATE SET thread_updated_at = excluded.thread_updated_at, last_turn_id = excluded.last_turn_id, last_item_id = excluded.last_item_id, last_item_count = excluded.last_item_count, synced_at = excluded.synced_at",
          [thread.source, thread.id, thread.updatedAt, lastTurn?.id ?? null, lastItem?.id ?? null, allItems.length, syncedAt]);
      }
      this.database.exec("COMMIT");
      return result;
    } catch (error) {
      if (this.database.isTransaction) this.database.exec("ROLLBACK");
      throw error;
    }
  }

  threadNeedsSync(threadId: string, updatedAt: string): boolean {
    this.assertOpen();
    const existing = this.get("SELECT thread_updated_at FROM capture_checkpoints WHERE source = 'trae' AND thread_id = ?", [threadId]);
    return !existing || String(existing.thread_updated_at) !== updatedAt;
  }

  readCheckpoint(threadId: string): CaptureCheckpoint | null {
    this.assertOpen();
    const row = this.get("SELECT * FROM capture_checkpoints WHERE source = 'trae' AND thread_id = ?", [threadId]);
    return row ? parseCheckpoint(row) : null;
  }

  checkpointStatus(): CaptureCheckpointStatus {
    this.assertOpen();
    const row = this.get("SELECT COUNT(*) AS threads, COALESCE(SUM(last_item_count), 0) AS tracked_items, MAX(synced_at) AS latest_synced_at, MAX(thread_updated_at) AS latest_thread_updated_at FROM capture_checkpoints WHERE source = 'trae'", []);
    return {
      threads: Number(row?.threads ?? 0),
      trackedItems: Number(row?.tracked_items ?? 0),
      ...(row?.latest_synced_at == null ? {} : { latestSyncedAt: String(row.latest_synced_at) }),
      ...(row?.latest_thread_updated_at == null ? {} : { latestThreadUpdatedAt: String(row.latest_thread_updated_at) }),
    };
  }

  cleanupExpired(retentionDays: number, now = Date.now()): { cutoff: string; threadsDeleted: number; itemsDeleted: number; candidatesDeleted: number } {
    this.assertOpen();
    const cutoff = new Date(now - retentionDays * 24 * 60 * 60 * 1000).toISOString();
    this.database.exec("BEGIN IMMEDIATE");
    try {
      const threadRows = this.all("SELECT source, thread_id FROM capture_threads WHERE updated_at < ? AND NOT EXISTS (SELECT 1 FROM memory_candidates WHERE memory_candidates.source = capture_threads.source AND memory_candidates.thread_id = capture_threads.thread_id AND memory_candidates.status = 'pending')", [cutoff]);
      let itemsDeleted = 0;
      let candidatesDeleted = 0;
      for (const row of threadRows) {
        const source = String(row.source);
        const threadId = String(row.thread_id);
        const count = this.get("SELECT COUNT(*) AS count FROM capture_items WHERE source = ? AND thread_id = ?", [source, threadId]);
        itemsDeleted += Number(count?.count ?? 0);
        const candidateCount = this.get("SELECT COUNT(*) AS count FROM memory_candidates WHERE source = ? AND thread_id = ? AND status <> 'pending'", [source, threadId]);
        candidatesDeleted += Number(candidateCount?.count ?? 0);
        this.run("DELETE FROM capture_items WHERE source = ? AND thread_id = ?", [source, threadId]);
        this.run("DELETE FROM capture_turns WHERE source = ? AND thread_id = ?", [source, threadId]);
        this.run("DELETE FROM memory_candidates WHERE source = ? AND thread_id = ? AND status <> 'pending'", [source, threadId]);
        this.run("DELETE FROM capture_threads WHERE source = ? AND thread_id = ?", [source, threadId]);
      }
      this.database.exec("COMMIT");
      return { cutoff, threadsDeleted: threadRows.length, itemsDeleted, candidatesDeleted };
    } catch (error) {
      if (this.database.isTransaction) this.database.exec("ROLLBACK");
      throw error;
    }
  }

  listCandidates(input: { status?: MemoryCandidate["status"]; limit?: number } = {}): MemoryCandidate[] {
    this.assertOpen();
    return this.all("SELECT * FROM memory_candidates WHERE status = ? ORDER BY created_at DESC, id DESC LIMIT ?", [input.status ?? "pending", input.limit ?? 50]).map(parseCandidate);
  }

  inspectThread(threadId: string): { thread: Row | null; turns: Row[]; items: ConversationItem[] } {
    this.assertOpen();
    const thread = this.get("SELECT * FROM capture_threads WHERE source = 'trae' AND thread_id = ?", [threadId]) ?? null;
    const turns = this.all("SELECT * FROM capture_turns WHERE source = 'trae' AND thread_id = ? ORDER BY started_at ASC, turn_id ASC", [threadId]);
    const items = this.all("SELECT content FROM capture_items WHERE source = 'trae' AND thread_id = ? ORDER BY turn_id ASC, ordinal ASC", [threadId])
      .map((row) => JSON.parse(String(row.content)) as ConversationItem);
    return { thread, turns, items };
  }

  async approveCandidate(candidateId: string, input: { memoryDatabasePath: string; userId: string; sensitivity?: MemoryCandidate["sensitivity"] }): Promise<{ candidate: MemoryCandidate; memoryEventId: string; duplicate: boolean }> {
    this.assertOpen();
    const row = this.get("SELECT * FROM memory_candidates WHERE id = ?", [candidateId]);
    if (!row) throw new Error("Memory candidate not found");
    const candidate = parseCandidate(row);
    if (candidate.status === "rejected") throw new Error("Rejected memory candidate cannot be approved");
    const sensitivity = input.sensitivity ?? candidate.sensitivity;
    if (candidate.status === "approved" && candidate.sensitivity !== sensitivity) {
      throw new Error("Memory candidate was already approved with sensitivity " + candidate.sensitivity);
    }
    const service = new MemoryService(new SqliteMemoryStore(input.memoryDatabasePath));
    try {
      const receipt = await service.remember({
        userId: input.userId, agentId: "trae-capture", key: candidate.key, value: candidate.value, kind: candidate.kind,
        scope: "user", sensitivity, userConfirmed: true, idempotencyKey: "capture-candidate:" + candidate.id,
        confidence: candidate.confidence, confidenceBasis: "user_asserted",
        metadata: { openContinuityType: "conversation_candidate", source: candidate.source, sourceThreadId: candidate.threadId,
          sourceTurnId: candidate.turnId, sourceItemId: candidate.itemId, captureQuality: candidate.captureQuality, rationale: candidate.rationale },
      });
      const reviewedAt = new Date().toISOString();
      this.run("UPDATE memory_candidates SET status = 'approved', sensitivity = ?, reviewed_at = ?, memory_event_id = ? WHERE id = ?", [sensitivity, reviewedAt, receipt.event.id, candidate.id]);
      return { candidate: { ...candidate, sensitivity, status: "approved", reviewedAt, memoryEventId: receipt.event.id }, memoryEventId: receipt.event.id, duplicate: receipt.duplicate };
    } finally { await service.close(); }
  }

  rejectCandidate(candidateId: string): MemoryCandidate {
    this.assertOpen();
    const row = this.get("SELECT * FROM memory_candidates WHERE id = ?", [candidateId]);
    if (!row) throw new Error("Memory candidate not found");
    const candidate = parseCandidate(row);
    if (candidate.status === "approved") throw new Error("Approved memory candidate cannot be rejected");
    const reviewedAt = new Date().toISOString();
    this.run("UPDATE memory_candidates SET status = 'rejected', reviewed_at = ? WHERE id = ?", [reviewedAt, candidate.id]);
    return { ...candidate, status: "rejected", reviewedAt };
  }

  readSyncState(): Record<string, unknown> | null {
    const row = this.get("SELECT * FROM capture_sync_state WHERE source = 'trae'", []);
    return row ?? null;
  }

  countCandidatesByStatus(): { pending: number; approved: number; rejected: number } {
    const count = (status: MemoryCandidate["status"]) => Number(this.get("SELECT COUNT(*) AS count FROM memory_candidates WHERE status = ?", [status])?.count ?? 0);
    return { pending: count("pending"), approved: count("approved"), rejected: count("rejected") };
  }

  recordSyncSuccess(result: CaptureSyncResult): void {
    this.run("INSERT INTO capture_sync_state (source, last_success_at, last_error_at, consecutive_failures, last_threads_seen, last_threads_imported, last_items_imported, last_candidates_created, last_pages_scanned, last_warning) VALUES ('trae', ?, NULL, 0, ?, ?, ?, ?, ?, ?) ON CONFLICT(source) DO UPDATE SET last_success_at = excluded.last_success_at, last_error_at = NULL, consecutive_failures = 0, last_threads_seen = excluded.last_threads_seen, last_threads_imported = excluded.last_threads_imported, last_items_imported = excluded.last_items_imported, last_candidates_created = excluded.last_candidates_created, last_pages_scanned = excluded.last_pages_scanned, last_warning = excluded.last_warning", [new Date().toISOString(), result.threadsSeen, result.threadsImported, result.itemsImported, result.candidatesCreated, result.pagesScanned ?? 0, result.warning ?? null]);
  }

  recordSyncFailure(error: unknown): void {
    const detail = (error instanceof Error ? error.message : String(error)).slice(0, 500);
    this.run("INSERT INTO capture_sync_state (source, last_error_at, consecutive_failures, last_warning) VALUES ('trae', ?, 1, ?) ON CONFLICT(source) DO UPDATE SET last_error_at = excluded.last_error_at, consecutive_failures = capture_sync_state.consecutive_failures + 1, last_warning = excluded.last_warning", [new Date().toISOString(), detail]);
  }

  close(): void { if (!this.closed) { this.database.close(); this.closed = true; } }

  private insertCandidates(candidates: MemoryCandidate[]): number {
    let created = 0;
    for (const candidate of candidates) {
      const info = this.database.prepare("INSERT OR IGNORE INTO memory_candidates (id, source, thread_id, turn_id, item_id, kind, memory_key, value, evidence, rationale, confidence, sensitivity, capture_quality, status, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)")
        .run(candidate.id, candidate.source, candidate.threadId, candidate.turnId, candidate.itemId, candidate.kind, candidate.key,
          candidate.value, candidate.evidence, candidate.rationale, candidate.confidence, candidate.sensitivity, candidate.captureQuality, candidate.status, candidate.createdAt);
      if (info.changes > 0) created += 1;
      else {
        this.database.prepare("UPDATE memory_candidates SET kind = ?, value = ?, evidence = ?, rationale = ?, confidence = ?, capture_quality = ? WHERE source = ? AND thread_id = ? AND turn_id = ? AND item_id = ? AND memory_key = ? AND status = 'pending'")
          .run(candidate.kind, candidate.value, candidate.evidence, candidate.rationale, candidate.confidence, candidate.captureQuality,
            candidate.source, candidate.threadId, candidate.turnId, candidate.itemId, candidate.key);
      }
    }
    return created;
  }

  private migrate(): void {
    const statements = [
      "CREATE TABLE IF NOT EXISTS capture_sync_state (source TEXT PRIMARY KEY, last_success_at TEXT, last_error_at TEXT, consecutive_failures INTEGER NOT NULL DEFAULT 0, last_threads_seen INTEGER NOT NULL DEFAULT 0, last_threads_imported INTEGER NOT NULL DEFAULT 0, last_items_imported INTEGER NOT NULL DEFAULT 0, last_candidates_created INTEGER NOT NULL DEFAULT 0, last_pages_scanned INTEGER NOT NULL DEFAULT 0, last_warning TEXT)",
      "CREATE TABLE IF NOT EXISTS capture_threads (source TEXT NOT NULL, thread_id TEXT NOT NULL, session_id TEXT NOT NULL, cwd TEXT NOT NULL, cli_version TEXT NOT NULL, preview TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, synced_at TEXT NOT NULL, PRIMARY KEY (source, thread_id))",
      "CREATE TABLE IF NOT EXISTS capture_checkpoints (source TEXT NOT NULL, thread_id TEXT NOT NULL, thread_updated_at TEXT NOT NULL, last_turn_id TEXT, last_item_id TEXT, last_item_count INTEGER NOT NULL DEFAULT 0, synced_at TEXT NOT NULL, PRIMARY KEY (source, thread_id))",
      "CREATE TABLE IF NOT EXISTS capture_turns (source TEXT NOT NULL, thread_id TEXT NOT NULL, turn_id TEXT NOT NULL, status TEXT NOT NULL, capture_quality TEXT NOT NULL, started_at TEXT, completed_at TEXT, PRIMARY KEY (source, thread_id, turn_id))",
      "CREATE TABLE IF NOT EXISTS capture_items (source TEXT NOT NULL, thread_id TEXT NOT NULL, turn_id TEXT NOT NULL, item_id TEXT NOT NULL, ordinal INTEGER NOT NULL, item_type TEXT NOT NULL, phase TEXT, raw_type TEXT NOT NULL, content TEXT NOT NULL, PRIMARY KEY (source, thread_id, turn_id, item_id))",
      "CREATE TABLE IF NOT EXISTS memory_candidates (id TEXT PRIMARY KEY, source TEXT NOT NULL, thread_id TEXT NOT NULL, turn_id TEXT NOT NULL, item_id TEXT NOT NULL, kind TEXT NOT NULL, memory_key TEXT NOT NULL, value TEXT NOT NULL, evidence TEXT NOT NULL, rationale TEXT NOT NULL, confidence REAL NOT NULL, sensitivity TEXT NOT NULL, capture_quality TEXT NOT NULL, status TEXT NOT NULL, created_at TEXT NOT NULL, reviewed_at TEXT, memory_event_id TEXT, UNIQUE (source, thread_id, turn_id, item_id, memory_key))",
      "CREATE INDEX IF NOT EXISTS capture_threads_updated_idx ON capture_threads (updated_at DESC)",
      "CREATE INDEX IF NOT EXISTS capture_checkpoints_synced_idx ON capture_checkpoints (synced_at DESC)",
      "CREATE INDEX IF NOT EXISTS memory_candidates_status_idx ON memory_candidates (status, created_at DESC)",
    ];
    for (const statement of statements) this.database.exec(statement);
  }
  private run(sql: string, values: SQLInputValue[]): void { this.database.prepare(sql).run(...values); }
  private get(sql: string, values: SQLInputValue[]): Row | undefined { return this.database.prepare(sql).get(...values) as Row | undefined; }
  private all(sql: string, values: SQLInputValue[]): Row[] { return this.database.prepare(sql).all(...values) as Row[]; }
  private assertOpen(): void { if (this.closed) throw new Error("Conversation Inbox is closed"); }
}
