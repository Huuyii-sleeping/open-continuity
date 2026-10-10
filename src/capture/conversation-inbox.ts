import { chmodSync, existsSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import { MemoryService } from "../core/memory-service.js";
import { SqliteMemoryStore } from "../sqlite/sqlite-memory-store.js";
import { extractMemoryCandidates } from "./candidate-extractor.js";
import { reviewMemoryCandidate } from "./candidate-review.js";
import { redactSensitiveText, sanitizeConversationItem } from "./sensitivity.js";
import type { CaptureCheckpoint, CaptureCheckpointStatus, CaptureSource, CaptureSyncResult, ConversationItem, ConversationThread, MemoryCandidate } from "./types.js";

type Row = Record<string, unknown>;

function parseCandidate(row: Row): MemoryCandidate {
  return {
    id: String(row.id), source: String(row.source), threadId: String(row.thread_id), turnId: String(row.turn_id), itemId: String(row.item_id),
    kind: row.kind as MemoryCandidate["kind"], key: String(row.memory_key), value: String(row.value), evidence: String(row.evidence),
    rationale: String(row.rationale), confidence: Number(row.confidence), dedupeKey: String(row.dedupe_key ?? row.memory_key),
    occurrenceCount: Number(row.occurrence_count ?? 1), lastSeenAt: String(row.last_seen_at ?? row.created_at),
    sensitivity: row.sensitivity as MemoryCandidate["sensitivity"],
    captureQuality: row.capture_quality as MemoryCandidate["captureQuality"], status: row.status as MemoryCandidate["status"],
    createdAt: String(row.created_at), reviewedAt: row.reviewed_at == null ? undefined : String(row.reviewed_at),
    memoryEventId: row.memory_event_id == null ? undefined : String(row.memory_event_id),
  };
}

function parseCheckpoint(row: Row): CaptureCheckpoint {
  return {
    source: String(row.source),
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
    this.database.exec("PRAGMA busy_timeout = 5000");
    this.migrate();
    this.secureDatabaseFiles();
  }

  importThreads(threads: ConversationThread[], source: CaptureSource = threads[0]?.source ?? "unknown"): CaptureSyncResult {
    this.assertOpen();
    if (threads.some((thread) => thread.source !== source)) throw new Error("Capture batch contains a source that does not match its Adapter");
    const result: CaptureSyncResult = { source, threadsSeen: threads.length, threadsImported: 0, turnsImported: 0, itemsImported: 0, candidatesCreated: 0, skippedEphemeral: 0, skippedNotAllowed: 0, skippedUnchanged: 0, sensitiveItemsRedacted: 0, candidatesBlockedSensitive: 0 };
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
            const candidates = extractMemoryCandidates({ source: thread.source, threadId: thread.id, turnId: turn.id, quality: turn.quality, item });
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

  threadNeedsSync(source: CaptureSource, threadId: string, updatedAt: string): boolean {
    this.assertOpen();
    const existing = this.get("SELECT thread_updated_at FROM capture_checkpoints WHERE source = ? AND thread_id = ?", [source, threadId]);
    return !existing || String(existing.thread_updated_at) !== updatedAt;
  }

  readCheckpoint(threadId: string, source: CaptureSource = "trae"): CaptureCheckpoint | null {
    this.assertOpen();
    const row = this.get("SELECT * FROM capture_checkpoints WHERE source = ? AND thread_id = ?", [source, threadId]);
    return row ? parseCheckpoint(row) : null;
  }

  checkpointStatus(source: CaptureSource = "trae"): CaptureCheckpointStatus {
    this.assertOpen();
    const row = this.get("SELECT COUNT(*) AS threads, COALESCE(SUM(last_item_count), 0) AS tracked_items, MAX(synced_at) AS latest_synced_at, MAX(thread_updated_at) AS latest_thread_updated_at FROM capture_checkpoints WHERE source = ?", [source]);
    return {
      threads: Number(row?.threads ?? 0),
      trackedItems: Number(row?.tracked_items ?? 0),
      ...(row?.latest_synced_at == null ? {} : { latestSyncedAt: String(row.latest_synced_at) }),
      ...(row?.latest_thread_updated_at == null ? {} : { latestThreadUpdatedAt: String(row.latest_thread_updated_at) }),
    };
  }

  cleanupExpired(retentionDays: number, now = Date.now(), pendingCandidateRetentionDays = 30): { cutoff: string; candidateCutoff: string; threadsDeleted: number; turnsDeleted: number; itemsDeleted: number; candidatesDeleted: number; occurrencesDeleted: number } {
    this.assertOpen();
    const cutoff = new Date(now - retentionDays * 24 * 60 * 60 * 1000).toISOString();
    const candidateCutoff = new Date(now - pendingCandidateRetentionDays * 24 * 60 * 60 * 1000).toISOString();
    this.database.exec("BEGIN IMMEDIATE");
    try {
      const candidateRows = this.all("SELECT id FROM memory_candidates WHERE (status = 'pending' AND last_seen_at < ?) OR (status <> 'pending' AND COALESCE(reviewed_at, last_seen_at, created_at) < ?)", [candidateCutoff, cutoff]);
      let occurrencesDeleted = Number(this.get("SELECT COUNT(*) AS count FROM memory_candidate_occurrences WHERE observed_at < ?", [candidateCutoff])?.count ?? 0);
      this.run("DELETE FROM memory_candidate_occurrences WHERE observed_at < ?", [candidateCutoff]);
      for (const row of candidateRows) {
        const candidateId = String(row.id);
        occurrencesDeleted += Number(this.get("SELECT COUNT(*) AS count FROM memory_candidate_occurrences WHERE candidate_id = ?", [candidateId])?.count ?? 0);
        this.run("DELETE FROM memory_candidate_occurrences WHERE candidate_id = ?", [candidateId]);
        this.run("DELETE FROM memory_candidates WHERE id = ?", [candidateId]);
      }
      this.database.exec("UPDATE memory_candidates SET occurrence_count = (SELECT COUNT(*) FROM memory_candidate_occurrences WHERE candidate_id = memory_candidates.id)");

      const turnRows = this.all("SELECT source, thread_id, turn_id FROM capture_turns WHERE (COALESCE(completed_at, started_at) IS NOT NULL AND COALESCE(completed_at, started_at) < ?) OR (completed_at IS NULL AND started_at IS NULL AND EXISTS (SELECT 1 FROM capture_threads AS thread WHERE thread.source = capture_turns.source AND thread.thread_id = capture_turns.thread_id AND thread.updated_at < ?))", [cutoff, cutoff]);
      let itemsDeleted = 0;
      for (const row of turnRows) {
        const source = String(row.source);
        const threadId = String(row.thread_id);
        const turnId = String(row.turn_id);
        const count = this.get("SELECT COUNT(*) AS count FROM capture_items WHERE source = ? AND thread_id = ? AND turn_id = ?", [source, threadId, turnId]);
        itemsDeleted += Number(count?.count ?? 0);
        this.run("DELETE FROM capture_items WHERE source = ? AND thread_id = ? AND turn_id = ?", [source, threadId, turnId]);
        this.run("DELETE FROM capture_turns WHERE source = ? AND thread_id = ? AND turn_id = ?", [source, threadId, turnId]);
      }
      const threadRows = this.all("SELECT source, thread_id FROM capture_threads WHERE updated_at < ? AND NOT EXISTS (SELECT 1 FROM capture_turns AS turn WHERE turn.source = capture_threads.source AND turn.thread_id = capture_threads.thread_id)", [cutoff]);
      for (const row of threadRows) this.run("DELETE FROM capture_threads WHERE source = ? AND thread_id = ?", [String(row.source), String(row.thread_id)]);
      this.database.exec("COMMIT");
      return { cutoff, candidateCutoff, threadsDeleted: threadRows.length, turnsDeleted: turnRows.length, itemsDeleted, candidatesDeleted: candidateRows.length, occurrencesDeleted };
    } catch (error) {
      if (this.database.isTransaction) this.database.exec("ROLLBACK");
      throw error;
    }
  }

  governanceStatus(): { threads: number; turns: number; items: number; candidates: { pending: number; approved: number; rejected: number }; occurrences: number } {
    this.assertOpen();
    const count = (table: string) => Number(this.get(`SELECT COUNT(*) AS count FROM ${table}`, [])?.count ?? 0);
    return {
      threads: count("capture_threads"),
      turns: count("capture_turns"),
      items: count("capture_items"),
      candidates: this.countCandidatesByStatus(),
      occurrences: count("memory_candidate_occurrences"),
    };
  }

  purgeInbox(): { threadsDeleted: number; turnsDeleted: number; itemsDeleted: number; candidatesDeleted: number; occurrencesDeleted: number; checkpointsDeleted: number } {
    this.assertOpen();
    const before = this.governanceStatus();
    const checkpointsDeleted = Number(this.get("SELECT COUNT(*) AS count FROM capture_checkpoints", [])?.count ?? 0);
    this.database.exec("BEGIN IMMEDIATE");
    try {
      this.database.exec("DELETE FROM memory_candidate_occurrences");
      this.database.exec("DELETE FROM memory_candidates");
      this.database.exec("DELETE FROM capture_items");
      this.database.exec("DELETE FROM capture_turns");
      this.database.exec("DELETE FROM capture_threads");
      this.database.exec("DELETE FROM capture_checkpoints");
      this.database.exec("DELETE FROM capture_sync_state");
      this.database.exec("COMMIT");
      return {
        threadsDeleted: before.threads,
        turnsDeleted: before.turns,
        itemsDeleted: before.items,
        candidatesDeleted: before.candidates.pending + before.candidates.approved + before.candidates.rejected,
        occurrencesDeleted: before.occurrences,
        checkpointsDeleted,
      };
    } catch (error) {
      if (this.database.isTransaction) this.database.exec("ROLLBACK");
      throw error;
    }
  }

  listCandidates(input: { status?: MemoryCandidate["status"]; limit?: number } = {}): MemoryCandidate[] {
    this.assertOpen();
    return this.all("SELECT * FROM memory_candidates WHERE status = ? ORDER BY created_at DESC, id DESC LIMIT ?", [input.status ?? "pending", input.limit ?? 50]).map(parseCandidate);
  }

  listCandidatesWithReview(input: { memoryDatabasePath: string; userId: string; status?: MemoryCandidate["status"]; limit?: number }): MemoryCandidate[] {
    const candidates = this.listCandidates(input);
    const store = new SqliteMemoryStore(input.memoryDatabasePath);
    try {
      const memories = store.inspectUserMemories({ userId: input.userId, includePrivate: true, limit: 1000 });
      return candidates.map((candidate) => ({ ...candidate, review: reviewMemoryCandidate(candidate, memories) }));
    } finally {
      store.close();
    }
  }

  inspectThread(threadId: string, source: CaptureSource = "trae"): { thread: Row | null; turns: Row[]; items: ConversationItem[] } {
    this.assertOpen();
    const thread = this.get("SELECT * FROM capture_threads WHERE source = ? AND thread_id = ?", [source, threadId]) ?? null;
    const turns = this.all("SELECT * FROM capture_turns WHERE source = ? AND thread_id = ? ORDER BY started_at ASC, turn_id ASC", [source, threadId]);
    const items = this.all("SELECT content FROM capture_items WHERE source = ? AND thread_id = ? ORDER BY turn_id ASC, ordinal ASC", [source, threadId])
      .map((row) => JSON.parse(String(row.content)) as ConversationItem);
    return { thread, turns, items };
  }

  async approveCandidate(candidateId: string, input: { memoryDatabasePath: string; userId: string; sensitivity?: MemoryCandidate["sensitivity"]; replaceMemoryId?: string }) {
    this.assertOpen();
    const row = this.get("SELECT * FROM memory_candidates WHERE id = ?", [candidateId]);
    if (!row) throw new Error("Memory candidate not found");
    const candidate = parseCandidate(row);
    if (candidate.status === "rejected") throw new Error("Rejected memory candidate cannot be approved");
    const sensitivity = input.sensitivity ?? candidate.sensitivity;
    if (candidate.status === "approved" && candidate.sensitivity !== sensitivity) {
      throw new Error("Memory candidate was already approved with sensitivity " + candidate.sensitivity);
    }
    if (candidate.status === "approved" && candidate.memoryEventId) {
      return { candidate, memoryEventId: candidate.memoryEventId, duplicate: true, evolution: { action: "already_approved" as const } };
    }
    const store = new SqliteMemoryStore(input.memoryDatabasePath);
    const service = new MemoryService(store);
    try {
      const memories = store.inspectUserMemories({ userId: input.userId, includePrivate: true, limit: 1000 });
      const review = reviewMemoryCandidate(candidate, memories);
      const duplicate = review.action === "link_duplicate" ? review.matches[0] : undefined;
      if (duplicate) {
        const reviewedAt = new Date().toISOString();
        this.run("UPDATE memory_candidates SET status = 'approved', sensitivity = ?, reviewed_at = ?, memory_event_id = ? WHERE id = ?", [sensitivity, reviewedAt, duplicate.sourceEventId, candidate.id]);
        return {
          candidate: { ...candidate, sensitivity, status: "approved" as const, reviewedAt, memoryEventId: duplicate.sourceEventId, review },
          memoryEventId: duplicate.sourceEventId,
          duplicate: true,
          evolution: { action: "linked_duplicate" as const, memoryId: duplicate.memoryId, version: duplicate.version },
        };
      }
      if (review.action === "replace_required" && !input.replaceMemoryId) {
        throw new Error(`Candidate may conflict with existing memory ${review.matches[0]!.memoryId}. Review it and rerun with --replace-memory <memory-id> to create an explicit new version.`);
      }
      const replacement = input.replaceMemoryId
        ? memories.find((memory) => memory.id === input.replaceMemoryId)
        : undefined;
      if (input.replaceMemoryId && !replacement) throw new Error("Replacement memory was not found for this user");
      if (replacement && replacement.kind !== candidate.kind) throw new Error("Replacement memory kind does not match the candidate kind");
      const receipt = await service.remember({
        userId: input.userId, agentId: `${candidate.source}-capture`, key: replacement?.key ?? candidate.key, value: candidate.value, kind: candidate.kind,
        scope: "user", sensitivity, userConfirmed: true, idempotencyKey: "capture-candidate:" + candidate.id,
        ...(replacement ? { expectedVersion: replacement.version } : {}),
        confidence: candidate.confidence, confidenceBasis: "user_asserted",
        metadata: { openContinuityType: "conversation_candidate", source: candidate.source, sourceThreadId: candidate.threadId,
          sourceTurnId: candidate.turnId, sourceItemId: candidate.itemId, captureQuality: candidate.captureQuality, rationale: candidate.rationale,
          occurrenceCount: candidate.occurrenceCount, ...(replacement ? { replacesMemoryId: replacement.id } : {}) },
      });
      const reviewedAt = new Date().toISOString();
      this.run("UPDATE memory_candidates SET status = 'approved', sensitivity = ?, reviewed_at = ?, memory_event_id = ? WHERE id = ?", [sensitivity, reviewedAt, receipt.event.id, candidate.id]);
      return {
        candidate: { ...candidate, sensitivity, status: "approved" as const, reviewedAt, memoryEventId: receipt.event.id, review },
        memoryEventId: receipt.event.id,
        duplicate: receipt.duplicate,
        evolution: { action: replacement ? "replaced" as const : "created" as const, memoryId: receipt.current.id, version: receipt.current.version },
      };
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

  readSyncState(source: CaptureSource = "trae"): Record<string, unknown> | null {
    const row = this.get("SELECT * FROM capture_sync_state WHERE source = ?", [source]);
    return row ?? null;
  }

  countCandidatesByStatus(): { pending: number; approved: number; rejected: number } {
    const count = (status: MemoryCandidate["status"]) => Number(this.get("SELECT COUNT(*) AS count FROM memory_candidates WHERE status = ?", [status])?.count ?? 0);
    return { pending: count("pending"), approved: count("approved"), rejected: count("rejected") };
  }

  recordSyncSuccess(result: CaptureSyncResult): void {
    this.run("INSERT INTO capture_sync_state (source, last_success_at, last_error_at, consecutive_failures, last_threads_seen, last_threads_imported, last_items_imported, last_candidates_created, last_pages_scanned, last_warning) VALUES (?, ?, NULL, 0, ?, ?, ?, ?, ?, ?) ON CONFLICT(source) DO UPDATE SET last_success_at = excluded.last_success_at, last_error_at = NULL, consecutive_failures = 0, last_threads_seen = excluded.last_threads_seen, last_threads_imported = excluded.last_threads_imported, last_items_imported = excluded.last_items_imported, last_candidates_created = excluded.last_candidates_created, last_pages_scanned = excluded.last_pages_scanned, last_warning = excluded.last_warning", [result.source, new Date().toISOString(), result.threadsSeen, result.threadsImported, result.itemsImported, result.candidatesCreated, result.pagesScanned ?? 0, result.warning ?? null]);
  }

  recordSyncFailure(source: CaptureSource, error: unknown): void {
    const detail = (error instanceof Error ? error.message : String(error)).slice(0, 500);
    this.run("INSERT INTO capture_sync_state (source, last_error_at, consecutive_failures, last_warning) VALUES (?, ?, 1, ?) ON CONFLICT(source) DO UPDATE SET last_error_at = excluded.last_error_at, consecutive_failures = capture_sync_state.consecutive_failures + 1, last_warning = excluded.last_warning", [source, new Date().toISOString(), detail]);
  }

  close(): void { if (!this.closed) { this.secureDatabaseFiles(); this.database.close(); this.closed = true; } }

  private insertCandidates(candidates: MemoryCandidate[]): number {
    let created = 0;
    for (const candidate of candidates) {
      const provenance = this.get("SELECT id FROM memory_candidates WHERE source = ? AND thread_id = ? AND turn_id = ? AND item_id = ? AND memory_key = ?", [candidate.source, candidate.threadId, candidate.turnId, candidate.itemId, candidate.key]);
      const duplicate = provenance ?? this.get("SELECT id FROM memory_candidates WHERE dedupe_key = ? AND status IN ('pending', 'approved') ORDER BY CASE status WHEN 'pending' THEN 0 ELSE 1 END, created_at ASC LIMIT 1", [candidate.dedupeKey]);
      if (duplicate) {
        const candidateId = String(duplicate.id);
        this.insertCandidateOccurrence(candidateId, candidate);
        this.run("UPDATE memory_candidates SET occurrence_count = (SELECT COUNT(*) FROM memory_candidate_occurrences WHERE candidate_id = ?), last_seen_at = MAX(last_seen_at, ?), confidence = MAX(confidence, ?), capture_quality = CASE WHEN capture_quality = 'complete' OR ? <> 'complete' THEN capture_quality ELSE 'complete' END WHERE id = ?", [candidateId, candidate.lastSeenAt, candidate.confidence, candidate.captureQuality, candidateId]);
        this.database.prepare("UPDATE memory_candidates SET kind = ?, value = ?, evidence = ?, rationale = ?, confidence = ?, capture_quality = ? WHERE source = ? AND thread_id = ? AND turn_id = ? AND item_id = ? AND memory_key = ? AND status = 'pending'")
          .run(candidate.kind, candidate.value, candidate.evidence, candidate.rationale, candidate.confidence, candidate.captureQuality,
            candidate.source, candidate.threadId, candidate.turnId, candidate.itemId, candidate.key);
        continue;
      }
      this.run("INSERT INTO memory_candidates (id, source, thread_id, turn_id, item_id, kind, memory_key, dedupe_key, value, evidence, rationale, confidence, occurrence_count, last_seen_at, sensitivity, capture_quality, status, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?, ?)",
        [candidate.id, candidate.source, candidate.threadId, candidate.turnId, candidate.itemId, candidate.kind, candidate.key, candidate.dedupeKey,
          candidate.value, candidate.evidence, candidate.rationale, candidate.confidence, candidate.lastSeenAt, candidate.sensitivity, candidate.captureQuality, candidate.status, candidate.createdAt]);
      this.insertCandidateOccurrence(candidate.id, candidate);
      created += 1;
    }
    return created;
  }

  private insertCandidateOccurrence(candidateId: string, candidate: MemoryCandidate): void {
    this.run("INSERT OR IGNORE INTO memory_candidate_occurrences (candidate_id, source, thread_id, turn_id, item_id, evidence, observed_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
      [candidateId, candidate.source, candidate.threadId, candidate.turnId, candidate.itemId, candidate.evidence, candidate.lastSeenAt]);
  }

  private migrate(): void {
    const statements = [
      "CREATE TABLE IF NOT EXISTS capture_sync_state (source TEXT PRIMARY KEY, last_success_at TEXT, last_error_at TEXT, consecutive_failures INTEGER NOT NULL DEFAULT 0, last_threads_seen INTEGER NOT NULL DEFAULT 0, last_threads_imported INTEGER NOT NULL DEFAULT 0, last_items_imported INTEGER NOT NULL DEFAULT 0, last_candidates_created INTEGER NOT NULL DEFAULT 0, last_pages_scanned INTEGER NOT NULL DEFAULT 0, last_warning TEXT)",
      "CREATE TABLE IF NOT EXISTS capture_threads (source TEXT NOT NULL, thread_id TEXT NOT NULL, session_id TEXT NOT NULL, cwd TEXT NOT NULL, cli_version TEXT NOT NULL, preview TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, synced_at TEXT NOT NULL, PRIMARY KEY (source, thread_id))",
      "CREATE TABLE IF NOT EXISTS capture_checkpoints (source TEXT NOT NULL, thread_id TEXT NOT NULL, thread_updated_at TEXT NOT NULL, last_turn_id TEXT, last_item_id TEXT, last_item_count INTEGER NOT NULL DEFAULT 0, synced_at TEXT NOT NULL, PRIMARY KEY (source, thread_id))",
      "CREATE TABLE IF NOT EXISTS capture_turns (source TEXT NOT NULL, thread_id TEXT NOT NULL, turn_id TEXT NOT NULL, status TEXT NOT NULL, capture_quality TEXT NOT NULL, started_at TEXT, completed_at TEXT, PRIMARY KEY (source, thread_id, turn_id))",
      "CREATE TABLE IF NOT EXISTS capture_items (source TEXT NOT NULL, thread_id TEXT NOT NULL, turn_id TEXT NOT NULL, item_id TEXT NOT NULL, ordinal INTEGER NOT NULL, item_type TEXT NOT NULL, phase TEXT, raw_type TEXT NOT NULL, content TEXT NOT NULL, PRIMARY KEY (source, thread_id, turn_id, item_id))",
      "CREATE TABLE IF NOT EXISTS memory_candidates (id TEXT PRIMARY KEY, source TEXT NOT NULL, thread_id TEXT NOT NULL, turn_id TEXT NOT NULL, item_id TEXT NOT NULL, kind TEXT NOT NULL, memory_key TEXT NOT NULL, dedupe_key TEXT NOT NULL, value TEXT NOT NULL, evidence TEXT NOT NULL, rationale TEXT NOT NULL, confidence REAL NOT NULL, occurrence_count INTEGER NOT NULL DEFAULT 1, last_seen_at TEXT NOT NULL, sensitivity TEXT NOT NULL, capture_quality TEXT NOT NULL, status TEXT NOT NULL, created_at TEXT NOT NULL, reviewed_at TEXT, memory_event_id TEXT, UNIQUE (source, thread_id, turn_id, item_id, memory_key))",
      "CREATE TABLE IF NOT EXISTS memory_candidate_occurrences (candidate_id TEXT NOT NULL, source TEXT NOT NULL, thread_id TEXT NOT NULL, turn_id TEXT NOT NULL, item_id TEXT NOT NULL, evidence TEXT NOT NULL, observed_at TEXT NOT NULL, PRIMARY KEY (candidate_id, source, thread_id, turn_id, item_id))",
      "CREATE INDEX IF NOT EXISTS capture_threads_updated_idx ON capture_threads (updated_at DESC)",
      "CREATE INDEX IF NOT EXISTS capture_checkpoints_synced_idx ON capture_checkpoints (synced_at DESC)",
      "CREATE INDEX IF NOT EXISTS memory_candidates_status_idx ON memory_candidates (status, created_at DESC)",
      "CREATE INDEX IF NOT EXISTS memory_candidates_dedupe_idx ON memory_candidates (dedupe_key, status)",
      "CREATE INDEX IF NOT EXISTS memory_candidate_occurrences_seen_idx ON memory_candidate_occurrences (observed_at DESC)",
    ];
    const candidateTableExists = Boolean(this.get("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'memory_candidates'", []));
    const existingColumns = candidateTableExists
      ? new Set(this.all("PRAGMA table_info(memory_candidates)", []).map((row) => String(row.name)))
      : new Set<string>();
    for (const statement of statements.slice(0, 5)) this.database.exec(statement);
    if (candidateTableExists) {
      if (!existingColumns.has("dedupe_key")) this.database.exec("ALTER TABLE memory_candidates ADD COLUMN dedupe_key TEXT");
      if (!existingColumns.has("occurrence_count")) this.database.exec("ALTER TABLE memory_candidates ADD COLUMN occurrence_count INTEGER NOT NULL DEFAULT 1");
      if (!existingColumns.has("last_seen_at")) this.database.exec("ALTER TABLE memory_candidates ADD COLUMN last_seen_at TEXT");
    } else {
      this.database.exec(statements[5]!);
    }
    for (const statement of statements.slice(6)) this.database.exec(statement);
    this.database.exec("UPDATE memory_candidates SET dedupe_key = COALESCE(dedupe_key, memory_key), last_seen_at = COALESCE(last_seen_at, created_at)");
    this.database.exec("INSERT OR IGNORE INTO memory_candidate_occurrences (candidate_id, source, thread_id, turn_id, item_id, evidence, observed_at) SELECT id, source, thread_id, turn_id, item_id, evidence, COALESCE(last_seen_at, created_at) FROM memory_candidates");
  }
  private run(sql: string, values: SQLInputValue[]): void { this.database.prepare(sql).run(...values); }
  private get(sql: string, values: SQLInputValue[]): Row | undefined { return this.database.prepare(sql).get(...values) as Row | undefined; }
  private all(sql: string, values: SQLInputValue[]): Row[] { return this.database.prepare(sql).all(...values) as Row[]; }
  private secureDatabaseFiles(): void {
    for (const path of [this.databasePath, `${this.databasePath}-wal`, `${this.databasePath}-shm`]) {
      if (existsSync(path)) chmodSync(path, 0o600);
    }
  }
  private assertOpen(): void { if (this.closed) throw new Error("Conversation Inbox is closed"); }
}
