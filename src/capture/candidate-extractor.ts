import { createHash, randomUUID } from "node:crypto";
import type { CaptureQuality, CaptureSource, ConversationItem, MemoryCandidate } from "./types.js";

interface CandidateSeed { value: string; rationale: string; kind: MemoryCandidate["kind"]; confidence: number; }

const patterns: Array<{ expression: RegExp; rationale: string; kind: MemoryCandidate["kind"]; confidence: number }> = [
  { expression: /(?:请)?记住[：,:，]?\s*(.+)/iu, rationale: "explicit_remember_request", kind: "user_fact", confidence: 0.98 },
  { expression: /我(?:更)?(?:喜欢|偏好|希望)[：,:，]?\s*(.+)/iu, rationale: "stated_preference", kind: "user_preference", confidence: 0.92 },
  { expression: /我不喜欢[：,:，]?\s*(.+)/iu, rationale: "stated_dislike", kind: "user_preference", confidence: 0.92 },
  { expression: /(?:我们)?(?:决定|确定)(?:以后)?[：,:，]?\s*(.+)/iu, rationale: "stated_decision", kind: "decision", confidence: 0.9 },
  { expression: /(?:以后|之后)(?:请)?\s*(.+)/iu, rationale: "future_instruction", kind: "user_preference", confidence: 0.9 },
  { expression: /(?:remember that|please remember)\s+(.+)/iu, rationale: "explicit_remember_request", kind: "user_fact", confidence: 0.98 },
  { expression: /(?:i prefer|i would like|i like)\s+(.+)/iu, rationale: "stated_preference", kind: "user_preference", confidence: 0.92 },
];

function normalizeStatement(value: string): string {
  return value.trim().replace(/^[：,:，\s]+/u, "").replace(/[。.!！\s]+$/u, "").trim();
}

function seeds(text: string): CandidateSeed[] {
  const values: CandidateSeed[] = [];
  const seen = new Set<string>();
  for (const pattern of patterns) {
    const match = pattern.expression.exec(text);
    const value = match?.[1] ? normalizeStatement(match[1]) : "";
    if (!value || value.length < 2 || value.length > 500 || seen.has(value)) continue;
    seen.add(value);
    values.push({ value, rationale: pattern.rationale, kind: pattern.kind, confidence: pattern.confidence });
  }
  return values;
}

function candidateFingerprint(kind: MemoryCandidate["kind"], value: string): string {
  const digest = createHash("sha256").update(`${kind}:\0${value}`).digest("hex").slice(0, 16);
  return `${kind}:${digest}`;
}

export function extractMemoryCandidates(input: { source: CaptureSource; threadId: string; turnId: string; quality: CaptureQuality; item: ConversationItem; now?: string }): MemoryCandidate[] {
  if (input.item.type !== "user_message" || !input.item.text || input.item.sensitive) return [];
  const createdAt = input.now ?? new Date().toISOString();
  return seeds(input.item.text).map((seed) => {
    const fingerprint = candidateFingerprint(seed.kind, seed.value);
    return {
    id: randomUUID(), source: input.source, threadId: input.threadId, turnId: input.turnId, itemId: input.item.id,
    kind: seed.kind, key: `captured:${fingerprint}`, value: seed.value, evidence: input.item.text!,
    rationale: seed.rationale, confidence: input.quality === "complete" ? seed.confidence : Math.min(seed.confidence, 0.6),
    dedupeKey: fingerprint, occurrenceCount: 1, lastSeenAt: createdAt,
    sensitivity: "private", captureQuality: input.quality, status: "pending", createdAt,
  } satisfies MemoryCandidate;
  });
}
