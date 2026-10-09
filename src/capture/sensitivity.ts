import type { ConversationItem } from "./types.js";

export interface SensitiveMatch { kind: "secret" | "credential" | "private_key" | "email" | "phone"; }

const patterns: Array<{ kind: SensitiveMatch["kind"]; expression: RegExp; replacement: string }> = [
  { kind: "private_key", expression: /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g, replacement: "<redacted:private-key>" },
  { kind: "secret", expression: /\b(?:sk|pk)-[A-Za-z0-9_-]{16,}\b/g, replacement: "<redacted:secret>" },
  { kind: "credential", expression: /\b(?:bearer|token|api[_ -]?key|password|passwd|secret)\s*[:=]\s*[^\s,;]+/giu, replacement: "<redacted:credential>" },
  { kind: "email", expression: /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/giu, replacement: "<redacted:email>" },
  { kind: "phone", expression: /(?<!\d)(?:\+?\d[\d -]{8,}\d)(?!\d)/g, replacement: "<redacted:phone>" },
];

export function redactSensitiveText(text: string): { text: string; matches: SensitiveMatch[] } {
  let redacted = text;
  const matches: SensitiveMatch[] = [];
  for (const pattern of patterns) {
    if (pattern.expression.test(redacted)) matches.push({ kind: pattern.kind });
    pattern.expression.lastIndex = 0;
    redacted = redacted.replace(pattern.expression, pattern.replacement);
    pattern.expression.lastIndex = 0;
  }
  return { text: redacted, matches };
}

function sensitiveKey(key: string): boolean {
  return /(?:api[_ -]?key|access[_ -]?key|secret|token|password|passwd|private[_ -]?key|client[_ -]?secret)/iu.test(key);
}

function redactUnknown(value: unknown, key?: string): { value: unknown; matches: SensitiveMatch[] } {
  if (key && sensitiveKey(key)) {
    return { value: "<redacted:credential>", matches: [{ kind: "credential" }] };
  }
  if (typeof value === "string") { const result = redactSensitiveText(value); return { value: result.text, matches: result.matches }; }
  if (Array.isArray(value)) {
    const results = value.map((entry) => redactUnknown(entry));
    return { value: results.map((result) => result.value), matches: results.flatMap((result) => result.matches) };
  }
  if (value && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>).map(([entryKey, entry]) => [entryKey, redactUnknown(entry, entryKey)] as const);
    return { value: Object.fromEntries(entries.map(([entryKey, result]) => [entryKey, result.value])), matches: entries.flatMap(([, result]) => result.matches) };
  }
  return { value, matches: [] };
}

export function sanitizeConversationItem(item: ConversationItem): { item: ConversationItem; matches: SensitiveMatch[] } {
  const text = item.text == null ? undefined : redactUnknown(item.text);
  const toolInput = item.toolInput === undefined ? undefined : redactUnknown(item.toolInput);
  const toolOutput = item.toolOutput === undefined ? undefined : redactUnknown(item.toolOutput);
  const matches = [...(text?.matches ?? []), ...(toolInput?.matches ?? []), ...(toolOutput?.matches ?? [])];
  const sanitized: ConversationItem = {
    ...item,
    ...(text ? { text: String(text.value) } : {}),
    ...(toolInput ? { toolInput: toolInput.value } : {}),
    ...(toolOutput ? { toolOutput: toolOutput.value } : {}),
    ...(matches.length ? { sensitive: true, redacted: true } : {}),
  };
  return { item: sanitized, matches };
}
