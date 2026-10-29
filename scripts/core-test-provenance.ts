import { createHash } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { join, relative } from "node:path";
const hash = (value: string | Buffer) => createHash("sha256").update(value).digest("hex");
function files(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap(entry => entry.isDirectory() ? files(join(directory, entry.name)) : entry.isFile() ? [join(directory, entry.name)] : []);
}
export function moduleTestProvenance(root: string) {
  const tree = (directory: string) => hash(files(join(root, directory)).sort().map(file => relative(root, file) + ":" + hash(readFileSync(file))).join("\n"));
  return { sourceHash: tree("src"), testHash: tree("test"), fixtureHash: tree("evals"), harnessHash: tree("scripts"), packageHash: hash(readFileSync(join(root, "package.json"))), lockHash: hash(readFileSync(join(root, "package-lock.json"))), node: process.version };
}
