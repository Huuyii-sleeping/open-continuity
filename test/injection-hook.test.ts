import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

describe("Trae UserPromptSubmit hook process", () => {
  const directories: string[] = [];
  afterEach(() => { for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true }); });

  it("accepts JSON stdin and always emits a valid fail-open action", () => {
    const root = mkdtempSync(join(tmpdir(), "open-continuity-hook-process-")); directories.push(root);
    const env = { ...process.env, HOME: join(root, "home"), OPEN_CONTINUITY_HOME: join(root, "data") };
    const output = execFileSync(process.execPath, [join(process.cwd(), "dist/src/injection-hook.js")], {
      env, encoding: "utf8", input: JSON.stringify({ prompt: "虚构 hook 输入", cwd: join(root, "workspace") }),
    });
    expect(JSON.parse(output)).toEqual({ continue: true, suppressOutput: true });
  });

  it("does not write prompt text to stdout on malformed stdin", () => {
    const root = mkdtempSync(join(tmpdir(), "open-continuity-hook-invalid-")); directories.push(root);
    const env = { ...process.env, HOME: join(root, "home"), OPEN_CONTINUITY_HOME: join(root, "data") };
    const output = execFileSync(process.execPath, [join(process.cwd(), "dist/src/injection-hook.js")], { env, encoding: "utf8", input: "not-json" });
    expect(JSON.parse(output)).toEqual({ continue: true, suppressOutput: true });
    expect(output).not.toContain("not-json");
  });
});
