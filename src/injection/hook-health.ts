import { statSync } from "node:fs";

export function isRegularHookFile(path: string): boolean {
  try { return statSync(path).isFile(); } catch { return false; }
}
