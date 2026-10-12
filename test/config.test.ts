import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { adapterCaptureConfig, adapterInjectionConfig, configPath, loadConfig } from "../src/cli/config.js";

describe("local config migration and adapter isolation", () => {
  const directories: string[] = [];
  afterEach(() => { for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true }); });

  function writeLegacyConfig(connectedAgents: Record<string, unknown> = {}) {
    const root = mkdtempSync(join(tmpdir(), "open-continuity-config-"));
    directories.push(root);
    const env = { ...process.env, HOME: join(root, "home"), OPEN_CONTINUITY_HOME: join(root, "data") };
    const path = configPath(env);
    mkdirSync(join(root, "data"), { recursive: true });
    const legacy = {
      version: 1,
      userId: "local-fictional-user",
      databasePath: join(root, "data", "memories.db"),
      connectedAgents,
      injection: { enabled: true, workspaces: [join(root, "workspace")], tokenBudget: 512, maxMemories: 6, timeoutMs: 150, receiptRetentionDays: 45, maxReceipts: 2500 },
      capture: { enabled: true, workspaces: [join(root, "workspace")], retentionDays: 9, pendingCandidateRetentionDays: 31, autoCleanup: false, intervalMs: 7000, pageSize: 15, maxThreads: 80, retryLimit: 2 },
    };
    writeFileSync(path, JSON.stringify(legacy, null, 2) + "\n");
    return { env, path, legacy };
  }

  it("migrates v1 permissions only to explicitly connected adapters and keeps a backup", () => {
    const { env, path, legacy } = writeLegacyConfig({
      claude: { binary: "/fictional/claude", connectedAt: "2030-01-01T00:00:00.000Z" },
    });

    const config = loadConfig(env);

    expect(config?.version).toBe(2);
    expect(config && adapterInjectionConfig(config, "claude")).toMatchObject({ enabled: true, workspaces: legacy.injection.workspaces, tokenBudget: 512 });
    expect(config && adapterCaptureConfig(config, "claude")).toMatchObject({ enabled: true, workspaces: legacy.capture.workspaces, retentionDays: 9 });
    expect(config && adapterInjectionConfig(config, "trae")).toMatchObject({ enabled: false, workspaces: [] });
    expect(config && adapterCaptureConfig(config, "codex")).toMatchObject({ enabled: false, workspaces: [] });
    expect(JSON.parse(readFileSync(path, "utf8"))).toMatchObject({ version: 2 });
    expect(existsSync(`${path}.v1.backup`)).toBe(true);
    expect(JSON.parse(readFileSync(`${path}.v1.backup`, "utf8"))).toEqual(legacy);
  });

  it("maps an unowned v1 configuration to Trae without granting Claude or Codex", () => {
    const { env } = writeLegacyConfig();
    const config = loadConfig(env)!;

    expect(adapterInjectionConfig(config, "trae").enabled).toBe(true);
    expect(adapterCaptureConfig(config, "trae").enabled).toBe(true);
    expect(adapterInjectionConfig(config, "claude")).toMatchObject({ enabled: false, workspaces: [] });
    expect(adapterCaptureConfig(config, "codex")).toMatchObject({ enabled: false, workspaces: [] });
  });
});
