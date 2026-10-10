import { join } from "node:path";
import { continuityHome } from "../cli/config.js";

export function captureDatabasePath(env: NodeJS.ProcessEnv = process.env): string {
  return join(continuityHome(env), "capture.db");
}
