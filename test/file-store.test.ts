import { mkdtempSync, rmSync } from "node:fs";
import { spawn } from "node:child_process";
import { homedir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { MemoryService } from "../src/core/memory-service.js";
import { JsonFileStore } from "../src/core/memory-store.js";

describe("JsonFileStore", () => {
  const temporaryDirectories: string[] = [];

  afterEach(() => {
    for (const directory of temporaryDirectories.splice(0)) rmSync(directory, { recursive: true, force: true });
  });

  it("shares state between separate runtime instances", async () => {
    const directory = mkdtempSync(join(homedir(), ".open-continuity-test-"));
    temporaryDirectories.push(directory);
    const filePath = join(directory, "memories.json");
    const codex = new MemoryService(new JsonFileStore(filePath));
    const claude = new MemoryService(new JsonFileStore(filePath));

    const first = await codex.remember({ userId: "u1", agentId: "codex", key: "response_style", value: "concise", kind: "user_preference", userConfirmed: true, idempotencyKey: "file-1" });
    expect((await claude.recall({ userId: "u1", agentId: "claude" })).memories[0]?.value).toBe("concise");
    await claude.remember({ userId: "u1", agentId: "claude", key: "response_style", value: "detailed", kind: "user_preference", userConfirmed: true, idempotencyKey: "file-2" });
    expect((await codex.recall({ userId: "u1", agentId: "codex" })).memories[0]?.value).toBe("detailed");
    expect((await codex.history({ userId: "u1", agentId: "codex", memoryId: first.current.id })).events).toHaveLength(2);
  });

  it("does not allow one user to forget another user memory", async () => {
    const directory = mkdtempSync(join(homedir(), ".open-continuity-test-"));
    temporaryDirectories.push(directory);
    const service = new MemoryService(new JsonFileStore(join(directory, "memories.json")));
    const memory = await service.remember({ userId: "u1", agentId: "codex", key: "language", value: "TypeScript", kind: "user_fact", idempotencyKey: "file-3" });

    await expect(service.forget({ userId: "u2", agentId: "claude", memoryId: memory.current.id })).rejects.toThrow("Memory not found");
    expect((await service.recall({ userId: "u1", agentId: "codex" })).memories).toHaveLength(1);
  });

  it("preserves concurrent writes from separate processes", async () => {
    const directory = mkdtempSync(join(homedir(), ".open-continuity-test-"));
    temporaryDirectories.push(directory);
    const filePath = join(directory, "memories.json");
    const workerPath = join(process.cwd(), "test/helpers/file-store-worker.ts");
    const workers = Array.from({ length: 8 }, (_, index) => new Promise<void>((resolve, reject) => {
      const child = spawn(process.execPath, ["--import", "tsx/esm", workerPath], {
        cwd: process.cwd(),
        env: { ...process.env, OPEN_CONTINUITY_TEST_FILE: filePath, OPEN_CONTINUITY_TEST_INDEX: String(index) },
        stdio: ["ignore", "pipe", "pipe"],
      });
      let stderr = "";
      child.stderr.on("data", (chunk) => { stderr += String(chunk); });
      child.once("error", reject);
      child.once("exit", (code) => code === 0 ? resolve() : reject(new Error("Worker exited with " + code + ": " + stderr)));
    }));

    await Promise.all(workers);
    const service = new MemoryService(new JsonFileStore(filePath));
    const result = await service.recall({ userId: "concurrent-user", agentId: "reader" });
    expect(result.memories).toHaveLength(8);
    expect((await service.history({ userId: "concurrent-user", agentId: "reader", limit: 100 })).events).toHaveLength(8);
    expect(new Set(result.memories.map((memory) => memory.key)).size).toBe(8);
  }, 15000);
});
