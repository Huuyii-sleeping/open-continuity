import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { MemoryService } from "../src/core/memory-service.js";
import { exportMemoryPackage, importMemoryPackage } from "../src/package/memory-package.js";
import { SqliteMemoryStore } from "../src/sqlite/sqlite-memory-store.js";

describe("Memory Package", () => {
  const directories: string[] = [];
  afterEach(() => { for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true }); });

  it("exports a checksummed portable package and imports its full history", async () => {
    const directory = mkdtempSync(join(tmpdir(), "open-continuity-package-")); directories.push(directory);
    const sourcePath = join(directory, "source.db"); const targetPath = join(directory, "target.db"); const packagePath = join(directory, "package");
    const source = new MemoryService(new SqliteMemoryStore(sourcePath));
    await source.remember({ userId: "demo-user", agentId: "trae", key: "test_runner", value: "Vitest", kind: "decision", idempotencyKey: "package-1" });
    await source.remember({ userId: "demo-user", agentId: "claude", key: "test_runner", value: "node:test", kind: "decision", idempotencyKey: "package-2" });
    await source.close();

    const manifest = exportMemoryPackage(sourcePath, packagePath);
    expect(manifest).toMatchObject({ format: "open-continuity-memory-package", version: "1.0", counts: { memories: 1, events: 2 } });
    expect(existsSync(join(packagePath, "manifest.json"))).toBe(true);
    importMemoryPackage(packagePath, targetPath, { targetUserId: "new-local-user" });
    const target = new MemoryService(new SqliteMemoryStore(targetPath));
    expect((await target.recall({ userId: "new-local-user", agentId: "codex" })).memories).toMatchObject([{ key: "test_runner", value: "node:test", version: 2 }]);
    expect((await target.history({ userId: "new-local-user", agentId: "codex" })).events).toHaveLength(2);
    await target.close();
  });

  it("exports only the selected local user's events", async () => {
    const directory = mkdtempSync(join(tmpdir(), "open-continuity-package-")); directories.push(directory);
    const database = join(directory, "source.db"); const packagePath = join(directory, "package");
    const service = new MemoryService(new SqliteMemoryStore(database));
    await service.remember({ userId: "owner", agentId: "trae", key: "language", value: "TypeScript", kind: "user_preference", idempotencyKey: "owner-1" });
    await service.remember({ userId: "other", agentId: "trae", key: "language", value: "Rust", kind: "user_preference", idempotencyKey: "other-1" });
    await service.close();
    expect(exportMemoryPackage(database, packagePath, { userId: "owner" }).counts).toEqual({ memories: 1, events: 1 });
    expect(readFileSync(join(packagePath, "events.jsonl"), "utf8")).not.toContain("Rust");
  });

  it("rejects a package whose event ledger was changed", async () => {
    const directory = mkdtempSync(join(tmpdir(), "open-continuity-package-")); directories.push(directory);
    const sourcePath = join(directory, "source.db"); const packagePath = join(directory, "package");
    const source = new MemoryService(new SqliteMemoryStore(sourcePath));
    await source.remember({ userId: "demo-user", agentId: "trae", key: "language", value: "TypeScript", kind: "user_preference", idempotencyKey: "tamper-1" });
    await source.close(); exportMemoryPackage(sourcePath, packagePath);
    const eventsPath = join(packagePath, "events.jsonl");
    writeFileSync(eventsPath, readFileSync(eventsPath, "utf8").replace("TypeScript", "Rust"));
    expect(() => importMemoryPackage(packagePath, join(directory, "target.db"))).toThrow("checksum verification failed");
  });
});
