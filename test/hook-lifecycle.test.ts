import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { installTraeInjectionHook, traeHookConfigPath, uninstallTraeInjectionHook } from "../src/injection/trae-hook-config.js";
import { claudeSettingsPath, installClaudeHooks, uninstallClaudeHooks } from "../src/injection/claude-hook-config.js";
import { installCodexHooks, uninstallCodexHooks } from "../src/injection/codex-hook-config.js";
import { hookManifestPath } from "../src/injection/hook-manifest.js";

describe("managed hook lifecycle", () => {
  const directories: string[] = [];
  afterEach(() => { for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true }); });

  function runtime(prefix: string) {
    const root = mkdtempSync(join(tmpdir(), prefix));
    directories.push(root);
    const home = join(root, "home");
    const env = { ...process.env, HOME: home, OPEN_CONTINUITY_HOME: join(root, "data") };
    return { root, home, env };
  }

  it("reconciles a stale Trae hook and uninstalls only OpenContinuity handlers", () => {
    const { root, env } = runtime("open-continuity-trae-lifecycle-");
    const path = traeHookConfigPath({ ...env, TRAECLI_HOME: join(root, "trae-cli") });
    const traeEnv = { ...env, TRAECLI_HOME: join(root, "trae-cli") };
    mkdirSync(join(root, "trae-cli"), { recursive: true });
    writeFileSync(path, JSON.stringify({ hooks: {
      UserPromptSubmit: [{ matcher: "fictional", hooks: [
        { type: "command", command: "fictional-user-hook" },
        { type: "command", command: "'/old/node' '/old/open-continuity/injection-hook.js'", statusMessage: "injecting OpenContinuity memory" },
      ] }],
      Stop: [{ hooks: [{ type: "command", command: "fictional-stop-hook" }] }],
    } }, null, 2));
    const current = join(root, "current", "injection-hook.js");

    expect(installTraeInjectionHook(traeEnv, process.execPath, current)).toMatchObject({ changed: true, installed: true });
    let document = JSON.parse(readFileSync(path, "utf8"));
    expect(JSON.stringify(document)).not.toContain("/old/open-continuity");
    expect(JSON.stringify(document)).toContain("fictional-user-hook");
    expect(JSON.stringify(document)).toContain("fictional-stop-hook");
    expect(JSON.stringify(document).match(/injecting OpenContinuity memory/g)).toHaveLength(1);
    expect(JSON.parse(readFileSync(hookManifestPath(traeEnv), "utf8")).agents.trae.hooks).toHaveLength(1);

    expect(uninstallTraeInjectionHook(traeEnv, process.execPath, current)).toMatchObject({ changed: true, installed: false });
    document = JSON.parse(readFileSync(path, "utf8"));
    expect(JSON.stringify(document)).toContain("fictional-user-hook");
    expect(JSON.stringify(document)).toContain("fictional-stop-hook");
    expect(JSON.stringify(document)).not.toContain("OpenContinuity memory");
  });

  it("reconciles and safely uninstalls Claude hooks while preserving user settings", () => {
    const { root, home, env } = runtime("open-continuity-claude-lifecycle-");
    const path = claudeSettingsPath(env);
    mkdirSync(join(home, ".claude"), { recursive: true });
    writeFileSync(path, JSON.stringify({ theme: "fictional-dark", hooks: {
      UserPromptSubmit: [{ hooks: [
        { type: "command", command: "fictional-user-hook", args: ["--keep"] },
        { type: "command", command: "/old/node", args: ["/old/claude-injection-hook.js"], statusMessage: "loading user-approved OpenContinuity memory" },
      ] }],
      Stop: [{ hooks: [
        { type: "command", command: "fictional-stop-hook", args: [] },
        { type: "command", command: "/old/node", args: ["/old/claude-capture-hook.js"], statusMessage: "capturing the completed turn for OpenContinuity review" },
      ] }],
    } }, null, 2));
    const paths = { injectionHookPath: join(root, "current", "claude-injection-hook.js"), captureHookPath: join(root, "current", "claude-capture-hook.js") };

    expect(installClaudeHooks(env, process.execPath, paths)).toMatchObject({ changed: true, installed: true });
    let settings = JSON.parse(readFileSync(path, "utf8"));
    expect(JSON.stringify(settings)).not.toContain("/old/claude-");
    expect(JSON.stringify(settings)).toContain("fictional-user-hook");
    expect(JSON.stringify(settings)).toContain("fictional-stop-hook");
    expect(JSON.stringify(settings).match(/OpenContinuity/g)).toHaveLength(2);

    expect(uninstallClaudeHooks(env, process.execPath, paths)).toMatchObject({ changed: true, installed: false });
    settings = JSON.parse(readFileSync(path, "utf8"));
    expect(settings.theme).toBe("fictional-dark");
    expect(JSON.stringify(settings)).toContain("fictional-user-hook");
    expect(JSON.stringify(settings)).toContain("fictional-stop-hook");
    expect(JSON.stringify(settings)).not.toContain("OpenContinuity");
  });

  it("reconciles and safely uninstalls Codex hooks while preserving unrelated events", () => {
    const { root, home, env } = runtime("open-continuity-codex-lifecycle-");
    const codexHome = join(home, ".codex");
    const codexEnv = { ...env, CODEX_HOME: codexHome };
    const path = join(codexHome, "hooks.json");
    mkdirSync(codexHome, { recursive: true });
    writeFileSync(path, JSON.stringify({ description: "fictional hooks", hooks: {
      SessionStart: [{ hooks: [{ type: "command", command: "fictional-session-hook" }] }],
      UserPromptSubmit: [{ hooks: [{ type: "command", command: "'/old/node' '/old/codex-injection-hook.js'", statusMessage: "loading user-approved OpenContinuity memory" }] }],
      Stop: [{ hooks: [{ type: "command", command: "'/old/node' '/old/codex-capture-hook.js'", statusMessage: "capturing the completed turn for OpenContinuity review" }] }],
    } }, null, 2));
    const paths = { injectionHookPath: join(root, "current", "codex-injection-hook.js"), captureHookPath: join(root, "current", "codex-capture-hook.js") };

    expect(installCodexHooks(codexEnv, process.execPath, paths)).toMatchObject({ changed: true, installed: true });
    let hooks = JSON.parse(readFileSync(path, "utf8"));
    expect(JSON.stringify(hooks)).not.toContain("/old/codex-");
    expect(JSON.stringify(hooks)).toContain("fictional-session-hook");
    expect(JSON.stringify(hooks).match(/OpenContinuity/g)).toHaveLength(2);

    expect(uninstallCodexHooks(codexEnv, process.execPath, paths)).toMatchObject({ changed: true, installed: false });
    hooks = JSON.parse(readFileSync(path, "utf8"));
    expect(hooks.description).toBe("fictional hooks");
    expect(JSON.stringify(hooks)).toContain("fictional-session-hook");
    expect(JSON.stringify(hooks)).not.toContain("OpenContinuity");
  });
});
