import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { OPEN_CONTINUITY_VERSION } from "../src/version.js";

describe("release version", () => {
  it("keeps the runtime protocol version aligned with package.json", () => {
    const packageJson = JSON.parse(readFileSync(join(process.cwd(), "package.json"), "utf8"));
    expect(OPEN_CONTINUITY_VERSION).toBe(packageJson.version);
  });
});
