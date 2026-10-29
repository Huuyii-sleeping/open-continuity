import { readdirSync } from "node:fs";
import { join } from "node:path";
import { assertCoreContractMap } from "./core-contract-map.js";

export interface ModuleTestRoute { module: string; route: string; files: string[]; }
function testFiles(root: string, directory: string): string[] {
  return readdirSync(join(root, directory), { withFileTypes: true }).flatMap(entry => entry.isDirectory()
    ? testFiles(root, directory + "/" + entry.name) : entry.isFile() && entry.name.endsWith(".test.ts") ? [directory + "/" + entry.name] : []);
}
export function coreTestCatalog(root: string): ModuleTestRoute[] {
  assertCoreContractMap(root);
  const groups = new Map<string, ModuleTestRoute>();
  const files = ["test/core", "test/storage", "test/reliability"].flatMap(directory => testFiles(root, directory));
  files.push("test/http.test.ts", "test/mcp.test.ts", "test/store-factory.test.ts");
  for (const file of files.sort()) {
    const basename = file.split("/").at(-1)!.replace(/\.test\.ts$/, "");
    let module: string, route: string;
    if (file.startsWith("test/core/")) {
      const parts = file.split("/"); module = parts.length > 3 ? parts[2]! : "architecture";
      route = basename;
    } else if (file.startsWith("test/storage/")) {
      module = basename.startsWith("sqlite-") ? "storage-sqlite" : basename.startsWith("postgres-") || basename === "storage-postgres-real" ? "storage-postgres" : basename.startsWith("inmemory-") ? "storage-inmemory" : basename === "file-store" ? "storage-json" : "storage-contract";
      route = basename.replace(/^(sqlite|postgres|inmemory)-/, "");
      // Keep file names compatible while exposing the operation they actually test.
      if (route === "operations-read") route = "history-port";
      if (route === "operations-write") route = "forget-port";
    } else if (file.startsWith("test/reliability/")) { module = "reliability"; route = basename.replace(/^reliability-/, ""); }
    else { module = "application"; route = basename; }
    const key = module + "/" + route;
    const group = groups.get(key) ?? { module, route, files: [] }; group.files.push(file); groups.set(key, group);
  }
  return [...groups.values()];
}
export function selectModuleTests(catalog: ModuleTestRoute[], module?: string, route?: string): ModuleTestRoute[] {
  if ((module !== undefined && !module.trim()) || (route !== undefined && !route.trim()) || (route && !module)) throw new Error("Choose a nonempty module before selecting a route");
  const compatibleRoute = route === "operations-read" ? "history-port" : route === "operations-write" ? "forget-port" : route;
  const selected = catalog.filter(item => (!module || item.module === module) && (!compatibleRoute || item.route === compatibleRoute));
  if (!selected.length || selected.some(item => item.files.length === 0)) throw new Error("Unknown or empty module test selection");
  return selected;
}
