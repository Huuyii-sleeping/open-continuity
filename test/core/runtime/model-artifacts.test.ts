import { createHash } from "node:crypto";
import { mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { modelArtifactFingerprint, verifyLocalModelArtifacts, type LocalModelArtifactManifest } from "../../../src/core/runtime/model-artifacts.js";

const sha256 = (value: string) => createHash("sha256").update(value).digest("hex");
const manifest: LocalModelArtifactManifest = { version: "local-model-artifacts-v1", modelFingerprint: "a".repeat(64),
  files: [{ path: "fictional-weights.bin", bytes: 4, sha256: sha256("fake") }] };

describe("model artifact integrity", () => {
  it("verifies explicit cache artifacts and rejects same-length tampering", async () => {
    const directory = await mkdtemp(join(tmpdir(), "oc-fictional-model-"));
    try {
      await writeFile(join(directory, manifest.files[0]!.path), "fake");
      expect(await verifyLocalModelArtifacts(directory, manifest, modelArtifactFingerprint(manifest))).toMatchObject({ verifiedFiles: 1 });
      await writeFile(join(directory, manifest.files[0]!.path), "evil");
      await expect(verifyLocalModelArtifacts(directory, manifest, modelArtifactFingerprint(manifest))).rejects.toThrow("unavailable or invalid");
    } finally { await rm(directory, { recursive: true, force: true }); }
  });
  it("rejects an unbound manifest before reading the cache", async () => {
    await expect(verifyLocalModelArtifacts("fictional-nonexistent-cache", manifest, "b".repeat(64))).rejects.toThrow("manifest fingerprint mismatch");
  });
  it.each(["../secret", "/tmp/secret", "C:\\secret", "nested/../secret", "./weights", "nested//weights", "nul\0name"])("rejects unsafe entry %s", path => {
    expect(() => modelArtifactFingerprint({ ...manifest, files: [{ ...manifest.files[0]!, path }] })).toThrow();
  });
  it("rejects missing artifacts and file symlinks without reading their target", async () => {
    const directory = await mkdtemp(join(tmpdir(), "oc-fictional-model-link-"));
    try {
      await expect(verifyLocalModelArtifacts(directory, manifest, modelArtifactFingerprint(manifest))).rejects.toThrow("unavailable or invalid");
      await writeFile(join(directory, "fictional-target"), "fake");
      await symlink(join(directory, "fictional-target"), join(directory, manifest.files[0]!.path));
      await expect(verifyLocalModelArtifacts(directory, manifest, modelArtifactFingerprint(manifest))).rejects.toThrow("unavailable or invalid");
    } finally { await rm(directory, { recursive: true, force: true }); }
  });
  it("fingerprints sorted files and rejects duplicates, empty manifests and excess bytes", () => {
    const other = { path: "graph.onnx", bytes: 5, sha256: sha256("graph") };
    expect(modelArtifactFingerprint({ ...manifest, files: [...manifest.files, other] })).toBe(modelArtifactFingerprint({ ...manifest, files: [other, ...manifest.files] }));
    for (const files of [[], [manifest.files[0]!, manifest.files[0]!], [{ ...other, bytes: 1024 ** 3 + 1 }]]) {
      expect(() => modelArtifactFingerprint({ ...manifest, files })).toThrow();
    }
  });
  it("does not follow a parent directory symlink outside the selected cache", async () => {
    const directory = await mkdtemp(join(tmpdir(), "oc-fictional-model-root-"));
    const outside = await mkdtemp(join(tmpdir(), "oc-fictional-model-outside-"));
    try {
      await writeFile(join(outside, "weights.bin"), "fake");
      await symlink(outside, join(directory, "nested"));
      const linked = { ...manifest, files: [{ ...manifest.files[0]!, path: "nested/weights.bin" }] };
      await expect(verifyLocalModelArtifacts(directory, linked, modelArtifactFingerprint(linked))).rejects.toThrow("unavailable or invalid");
    } finally { await rm(directory, { recursive: true, force: true }); await rm(outside, { recursive: true, force: true }); }
  });
});
