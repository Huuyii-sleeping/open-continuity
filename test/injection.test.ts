import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { defaultConfig, saveConfig } from "../src/cli/config.js";
import { runInjectionHook, type InjectionRuntime } from "../src/injection/injection-service.js";
import type { ContextPackResult } from "../src/shared/types.js";
import { MemoryService } from "../src/core/memory-service.js";
import { SqliteMemoryStore } from "../src/sqlite/sqlite-memory-store.js";

const fictionalPrompt = "请为虚构的蓝色纸飞机项目给出下一步建议";

describe("Trae injection adapter", () => {
  const directories: string[] = [];
  afterEach(() => { for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true }); });

  function setup() {
    const root = mkdtempSync(join(tmpdir(), "open-continuity-injection-"));
    directories.push(root);
    const workspace = join(root, "fictional-workspace");
    const env = { ...process.env, HOME: join(root, "home"), OPEN_CONTINUITY_HOME: join(root, "data") };
    const config = defaultConfig(env);
    config.injection = { ...config.injection, enabled: true, workspaces: [workspace] };
    saveConfig(config, env);
    return { root, workspace, env, config };
  }

  async function remember(config: ReturnType<typeof defaultConfig>, input: { key: string; value: string; sensitivity: "public" | "private"; userConfirmed: boolean }) {
    const service = new MemoryService(new SqliteMemoryStore(config.databasePath));
    try {
      await service.remember({
        userId: config.userId, agentId: "fictional-agent", key: input.key, value: input.value, kind: "user_preference",
        scope: "user", sensitivity: input.sensitivity, userConfirmed: input.userConfirmed,
        idempotencyKey: `fictional-${input.key}-${input.sensitivity}`, metadata: {},
      });
    } finally { await service.close(); }
  }

  it("fails open by default and records no prompt text", async () => {
    const root = mkdtempSync(join(tmpdir(), "open-continuity-injection-disabled-"));
    directories.push(root);
    const env = { ...process.env, HOME: join(root, "home"), OPEN_CONTINUITY_HOME: join(root, "data") };
    const config = defaultConfig(env);
    saveConfig(config, env);

    const output = await runInjectionHook({ prompt: "虚构秘密提示 blue-paper-plane", cwd: join(root, "workspace"), session_id: "fictional-session", turn_id: "fictional-turn" }, env);
    expect(output).toEqual({ continue: true, suppressOutput: true });
    const receiptPath = join(root, "data", "injection-receipts.jsonl");
    expect(existsSync(receiptPath)).toBe(true);
    const receipt = JSON.parse(readFileSync(receiptPath, "utf8"));
    expect(receipt).toMatchObject({ outcome: "disabled", sessionId: "fictional-session", turnId: "fictional-turn" });
    expect(readFileSync(receiptPath, "utf8")).not.toContain("虚构秘密提示");
    expect(readFileSync(receiptPath, "utf8")).not.toContain("blue-paper-plane");
  });

  it("injects only approved public memory for an allowed workspace", async () => {
    const { env, workspace, config } = setup();
    await remember(config, { key: "response_style", value: "先给结论，再列出验证结果", sensitivity: "public", userConfirmed: true });
    await remember(config, { key: "private_note", value: "虚构私密内容", sensitivity: "private", userConfirmed: true });
    await remember(config, { key: "unconfirmed_note", value: "虚构但未确认的内容", sensitivity: "public", userConfirmed: false });

    const output = await runInjectionHook({ prompt: "请按照先给结论，再列出验证结果的风格处理蓝色纸飞机项目", cwd: workspace, session_id: "fictional-session", turn_id: "fictional-turn" }, env);
    expect(output.continue).toBe(true);
    expect(output.hookSpecificOutput?.hookEventName).toBe("UserPromptSubmit");
    const context = output.hookSpecificOutput?.additionalContext ?? "";
    expect(context).toContain("response_style");
    expect(context).toContain("先给结论，再列出验证结果");
    expect(context).not.toContain("private_note");
    expect(context).not.toContain("虚构私密内容");
    expect(context).not.toContain("unconfirmed_note");
    expect(context).not.toContain("虚构但未确认的内容");

    const receipt = JSON.parse(readFileSync(join(env.OPEN_CONTINUITY_HOME!, "injection-receipts.jsonl"), "utf8"));
    expect(receipt).toMatchObject({ outcome: "injected", memoryIds: expect.any(Array) });
    expect(receipt.promptFingerprint).toMatch(/^[a-f0-9]{24}$/);
  });

  it("normalizes descriptive prompts before lookup without broadening the query", async () => {
    const { env, workspace, config } = setup();
    await remember(config, { key: "verification_style", value: "每次修改后运行类型检查", sensitivity: "public", userConfirmed: true });

    const output = await runInjectionHook({ prompt: "请按照每次修改后运行类型检查的方式处理虚构代码。", cwd: workspace }, env);
    expect(output.hookSpecificOutput).toBeDefined();
    const context = output.hookSpecificOutput?.additionalContext ?? "";
    expect(context).toContain("verification_style");
    expect(context).toContain("每次修改后运行类型检查");
  });

  it("extracts an explicit topic identifier from a natural-language question", async () => {
    const { env, workspace, config } = setup();
    await remember(config, {
      key: "topic_phrase",
      value: "讨论 HAPPYREALZEBRAQUARTZ 时使用短语 HAPPYCAPTURECONFIRMED",
      sensitivity: "public",
      userConfirmed: true,
    });

    const output = await runInjectionHook({
      prompt: "讨论 HAPPYREALZEBRAQUARTZ 时应该使用什么短语？",
      cwd: workspace,
    }, env);

    const context = output.hookSpecificOutput?.additionalContext ?? "";
    expect(context).toContain("topic_phrase");
    expect(context).toContain("HAPPYCAPTURECONFIRMED");
    const receipt = JSON.parse(readFileSync(join(env.OPEN_CONTINUITY_HOME!, "injection-receipts.jsonl"), "utf8"));
    expect(receipt).toMatchObject({ outcome: "injected", memoryIds: expect.any(Array) });
  });

  it("skips unrelated prompts and disallowed workspace subtrees", async () => {
    const { env, workspace, config } = setup();
    await remember(config, { key: "response_style", value: "先给结论，再列出验证结果", sensitivity: "public", userConfirmed: true });

    const unrelated = await runInjectionHook({ prompt: "请检查虚构的纸飞机颜色", cwd: workspace }, env);
    expect(unrelated).toEqual({ continue: true, suppressOutput: true });
    const outside = await runInjectionHook({ prompt: fictionalPrompt, cwd: join(env.OPEN_CONTINUITY_HOME!, "not-allowed") }, env);
    expect(outside).toEqual({ continue: true, suppressOutput: true });
  });

  it("fails open when the database fails or the bounded lookup times out", async () => {
    const { env, workspace, config } = setup();
    config.databasePath = join(config.databasePath, "not-a-database-directory");
    saveConfig(config, env);
    await expect(runInjectionHook({ prompt: fictionalPrompt, cwd: workspace }, env)).resolves.toEqual({ continue: true, suppressOutput: true });

    const timeoutConfig = { ...config, databasePath: join(env.OPEN_CONTINUITY_HOME!, "memories.db") };
    saveConfig(timeoutConfig, env);
    const delayedPack: ContextPackResult = { context: "late", items: [], omitted: [], budget: { requestedTokens: 64, usedTokens: 0, remainingTokens: 64, maxMemories: 1, estimation: "utf8_bytes_v1" } };
    const runtime: InjectionRuntime = { createService: () => ({
      context: async () => { await new Promise((resolve) => setTimeout(resolve, 80)); return delayedPack; },
      close: async () => undefined,
    }) };
    timeoutConfig.injection = { ...timeoutConfig.injection, timeoutMs: 25 };
    saveConfig(timeoutConfig, env);
    const output = await runInjectionHook({ prompt: fictionalPrompt, cwd: workspace }, env, runtime);
    expect(output).toEqual({ continue: true, suppressOutput: true });
    const receipts = readFileSync(join(env.OPEN_CONTINUITY_HOME!, "injection-receipts.jsonl"), "utf8").trim().split("\n").map((line) => JSON.parse(line));
    expect(receipts.at(-1)).toMatchObject({ outcome: "timeout", detail: "injection_timeout" });
  });
});
