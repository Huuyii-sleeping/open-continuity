import { constants, closeSync, fstatSync, fsyncSync, openSync, readSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { parseArgs } from "node:util";
import type { LocalConfig } from "./config.js";
import { MemoryService } from "../core/application/memory-service.js";
import { SqliteMemoryStore } from "../storage/sqlite/sqlite-memory-store.js";
import { OpenContinuityError } from "../shared/errors.js";
import { handoffPrepareInputSchema, validateHandoffDraft } from "../core/memory/handoff/review.js";
import { renderHandoffResume, renderHandoffReview } from "../core/memory/handoff/render.js";

function readJson(path: string): unknown {
  let fd: number | undefined;
  try {
    fd = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.size > 256 * 1024) throw new Error("invalid file");
    const buffer = Buffer.alloc(256 * 1024 + 1); let bytes = 0;
    while (bytes < buffer.length) {
      const count = readSync(fd, buffer, bytes, buffer.length - bytes, bytes);
      if (!count) break;
      bytes += count;
    }
    if (bytes > 256 * 1024) throw new Error("file grew");
    const text = new TextDecoder("utf-8", { fatal: true }).decode(buffer.subarray(0, bytes));
    return JSON.parse(text);
  } catch { throw new OpenContinuityError("VALIDATION_ERROR", "Handoff input must be a regular JSON file of at most 256KiB", 400); }
  finally { if (fd !== undefined) closeSync(fd); }
}
function draftFile(path: string, config: LocalConfig) {
  const raw = readJson(path);
  const value = raw && typeof raw === "object" && "draft" in raw ? raw.draft : raw;
  const draft = validateHandoffDraft(value);
  if (draft.input.userId !== config.userId) throw new OpenContinuityError("FORBIDDEN", "Draft belongs to a different local user", 403);
  return draft;
}
function writeDraft(path: string, value: unknown) {
  let fd: number | undefined;
  try {
    fd = openSync(path, "wx", 0o600);
    writeFileSync(fd, JSON.stringify(value) + "\n"); fsyncSync(fd);
  } catch { throw new OpenContinuityError("VALIDATION_ERROR", "Choose a new draft output file; existing files are not overwritten", 400); }
  finally { if (fd !== undefined) closeSync(fd); }
}

/** Normal local-user entry. Configuration supplies user identity; no adapter settings or transcript reads. */
export async function runHandoffCommand(args: string[], config: LocalConfig) {
  const { values, positionals } = parseArgs({ args, allowPositionals: true, strict: true, options: {
    agent: { type: "string" }, input: { type: "string" }, output: { type: "string" }, reviewed: { type: "string" },
    share: { type: "boolean" }, private: { type: "boolean" }, yes: { type: "boolean" }, json: { type: "boolean" },
  } });
  const command = positionals[0];
  if (!["prepare", "review", "confirm", "resume"].includes(command ?? "") || positionals.length > (command === "prepare" ? 1 : 2))
    throw new OpenContinuityError("VALIDATION_ERROR", "Use handoff prepare, review, confirm or resume", 400);
  const allowed: Record<string, readonly string[]> = { prepare: ["agent", "input", "output", "share", "private", "json"], review: ["json"],
    confirm: ["agent", "yes", "reviewed", "json"], resume: ["agent", "private", "json"] };
  if (Object.keys(values).some(key => !allowed[command!].includes(key))) throw new OpenContinuityError("VALIDATION_ERROR", "Option does not apply to this handoff operation", 400);
  if (command === "review") {
    if (!positionals[1]) throw new OpenContinuityError("VALIDATION_ERROR", "A draft file is required", 400);
    const draft = draftFile(positionals[1], config);
    return { ok: true, operation: "handoff_review", draft, text: renderHandoffReview(draft) };
  }
  const agentId = values.agent?.trim();
  if (!agentId) throw new OpenContinuityError("VALIDATION_ERROR", "Specify --agent for the source or receiving Agent", 400);
  if (command === "confirm") {
    if (!positionals[1] || !values.yes || !values.reviewed) throw new OpenContinuityError("VALIDATION_ERROR", "Review the draft, then confirm with --yes --reviewed <fingerprint>", 400);
    if (values.share) throw new OpenContinuityError("VALIDATION_ERROR", "Sharing is selected during prepare; changing visibility requires a new review", 400);
  }
  if (command === "prepare" && !values.input) throw new OpenContinuityError("VALIDATION_ERROR", "Provide --input with the current task summary JSON", 400);
  if (command === "resume" && !positionals[1]) throw new OpenContinuityError("VALIDATION_ERROR", "A task identifier is required", 400);
  const service = new MemoryService(new SqliteMemoryStore(config.databasePath));
  try {
    if (command === "prepare") {
      const raw = readJson(values.input!);
      if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new OpenContinuityError("VALIDATION_ERROR", "Task summary must be a JSON object", 400);
      const draft = await service.prepareHandoff(handoffPrepareInputSchema.parse({ ...raw, userId: config.userId, agentId,
        sensitivity: values.share ? "public" : "private", includePrivate: Boolean(values.private) }));
      const path = resolve(values.output ?? "handoff-draft.json"); writeDraft(path, draft);
      return { ok: true, operation: "handoff_prepare", status: "awaiting_user_confirmation", draftPath: path, draft,
        text: renderHandoffReview(draft) + "\n草稿已保存。核对后运行 handoff confirm，传入草稿文件、来源Agent、--yes和上面的确认指纹。\n" };
    }
    if (command === "confirm") {
      const draft = draftFile(positionals[1], config);
      const result = await service.confirmHandoff({ userId: config.userId, agentId, draft, reviewedFingerprint: values.reviewed!, userConfirmed: true });
      return { ok: true, operation: "handoff_confirm", ...result, text: result.memory.duplicate
        ? "此次确认已处理，重复请求未写入新版本。请恢复查看当前交接。\n"
        : "交接已确认并保存。接手Agent可使用 memory_handoff_resume 或 handoff resume 恢复。\n" };
    }
    const result = await service.resumeHandoff({ userId: config.userId, agentId, taskId: positionals[1], includePrivate: Boolean(values.private) });
    return { ok: result.status === "ready", operation: "handoff_resume", ...result, text: renderHandoffResume(result) };
  } finally { await service.closeGracefully(); }
}
