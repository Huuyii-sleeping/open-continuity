import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { lstat, open, realpath } from "node:fs/promises";
import { isAbsolute, relative, resolve } from "node:path";
import { OpenContinuityError } from "../../shared/errors.js";

export interface LocalModelArtifact { path: string; bytes: number; sha256: string; }
export interface LocalModelArtifactManifest {
  version: "local-model-artifacts-v1";
  modelFingerprint: string;
  files: readonly LocalModelArtifact[];
}

export function modelArtifactFingerprint(manifest: LocalModelArtifactManifest): string {
  if (manifest.version !== "local-model-artifacts-v1" || !/^[a-f0-9]{64}$/.test(manifest.modelFingerprint)
    || !Array.isArray(manifest.files) || !manifest.files.length || manifest.files.length > 32) {
    throw new OpenContinuityError("VALIDATION_ERROR", "Invalid model artifact manifest", 400);
  }
  const seen = new Set<string>(); let total = 0;
  for (const file of manifest.files) {
    if (!file || typeof file.path !== "string" || !file.path || isAbsolute(file.path) || file.path.includes("\\") || file.path.includes(":")
      || file.path.includes("\0") || file.path.split("/").some((part: string) => !part || part === "." || part === "..") || seen.has(file.path)
      || !Number.isSafeInteger(file.bytes) || file.bytes < 1 || !/^[a-f0-9]{64}$/.test(file.sha256)) {
      throw new OpenContinuityError("VALIDATION_ERROR", "Invalid model artifact entry", 400);
    }
    seen.add(file.path); total += file.bytes;
  }
  if (total > 1024 ** 3) throw new OpenContinuityError("VALIDATION_ERROR", "Model artifact budget exceeded", 400);
  return createHash("sha256").update(JSON.stringify({ version: manifest.version, modelFingerprint: manifest.modelFingerprint,
    files: [...manifest.files].sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0) })).digest("hex");
}

/** Verify task/user-selected cache before loading. This is integrity checking, not publisher authentication. */
export async function verifyLocalModelArtifacts(directory: string, manifest: LocalModelArtifactManifest, expectedManifestFingerprint: string) {
  const fingerprint = modelArtifactFingerprint(manifest);
  if (fingerprint !== expectedManifestFingerprint) throw new OpenContinuityError("STORAGE_ERROR", "Model artifact manifest fingerprint mismatch", 500);
  try {
    const root = await realpath(directory);
    for (const file of manifest.files) {
      const path = resolve(root, file.path);
      const metadata = await lstat(path);
      if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.size !== file.bytes) throw new Error("invalid artifact file");
      const canonical = await realpath(path);
      const location = relative(root, canonical);
      if (location.startsWith("..") || isAbsolute(location)) throw new Error("artifact escaped cache");
      const handle = await open(canonical, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
      try {
        const opened = await handle.stat();
        if (!opened.isFile() || opened.size !== file.bytes) throw new Error("artifact file changed");
        const hash = createHash("sha256");
        const buffer = Buffer.alloc(64 * 1024); let bytes = 0;
        for (;;) {
          const read = await handle.read(buffer, 0, buffer.length, null);
          if (!read.bytesRead) break;
          bytes += read.bytesRead;
          if (bytes > file.bytes) throw new Error("artifact grew beyond manifest");
          hash.update(buffer.subarray(0, read.bytesRead));
        }
        if (bytes !== file.bytes || hash.digest("hex") !== file.sha256) throw new Error("artifact checksum mismatch");
      } finally { await handle.close(); }
    }
    return { manifestFingerprint: fingerprint, modelFingerprint: manifest.modelFingerprint, verifiedFiles: manifest.files.length };
  } catch {
    // Never forward a path, model-parser diagnostic, or file contents to the public error.
    throw new OpenContinuityError("STORAGE_ERROR", "Local model artifacts are unavailable or invalid", 500);
  }
}
