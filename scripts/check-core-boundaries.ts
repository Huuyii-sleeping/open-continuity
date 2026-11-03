import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

export interface DependencyEdge { from: string; to: string; }
export interface BoundaryViolation extends DependencyEdge { reason: string; }
const canonical = (name: string) => name.startsWith("src/core/") && name.split("/").length > 3;
const leaf = (name: string) => /\/(?:readers|retrievers)\/(exact|structured|full-text)\.ts$/.exec(name)?.[1];
const independentRoute = (name: string) => /^(src\/core\/query)\/(recall|history)\.ts$|^(src\/core\/context\/packing)\/(rank|coverage)\.ts$|^(src\/core\/context\/selection)\/(input-order|legacy|relevance)\.ts$|^(src\/core\/retrieval\/ranking)\/(native|rrf)\.ts$|^(src\/storage\/[^/]+\/writes)\/(remember|forget)\.ts$/.exec(name);

export function boundaryViolations(edges: DependencyEdge[]): BoundaryViolation[] {
  const violations: BoundaryViolation[] = [];
  for (const edge of edges) {
    const { from, to } = edge;
    let reason: string | undefined;
    if ((canonical(from) || from.startsWith("src/storage/")) && /^(?:src\/core\/[^/]+|src\/(?:sqlite|postgres)\/[^/]+)\.ts$/.test(to)) reason = "implementation imports a compatibility facade";
    else if (canonical(from) && !from.startsWith("src/core/application/") && to.startsWith("src/storage/") && to !== "src/storage/contracts.ts") reason = "Core domain depends on a storage implementation";
    else if (canonical(from) && !from.startsWith("src/core/application/") && ["pg", "node:sqlite"].includes(to)) reason = "Core domain depends on a database driver";
    else if (from.startsWith("src/core/retrieval/reranking/") && /^src\/core\/(?:application|context|query|answer|facts|policy|retrieval\/dense)\//.test(to)) reason = "relevance scoring depends on a consumer or Dense admission";
    else if (/^src\/core\/retrieval\/dense\/reranking\/(?:order|selection)\.ts$/.test(from) && to.startsWith("src/core/") && !/\/contracts\.ts$/.test(to)) reason = "pure Dense ordering or selection depends on a runtime implementation";
    else if (from.startsWith("src/storage/") && /^src\/core\/(application|context|query|answer|runtime)\//.test(to)) reason = "storage depends on a consuming or application module";
    else if (from.startsWith("src/storage/") && /^src\/core\/retrieval\/(pipeline|candidates|ranking)\.ts$/.test(to)) reason = "storage depends on retrieval orchestration or ranking";
    else if (from.startsWith("src/core/context/") && /^src\/core\/(application|query|answer)\//.test(to)) reason = "Context depends on a higher-level consumer";
    else if (from.startsWith("src/core/context/") && to === "src/core/retrieval/pipeline.ts") reason = "Context depends on a concrete retrieval pipeline";
    else if (from.startsWith("src/core/query/") && (to === "src/core/retrieval/pipeline.ts" || to.startsWith("src/core/application/"))) reason = "Query depends on a concrete service or pipeline";
    else if (from.startsWith("src/core/runtime/") && to.startsWith("src/core/application/")) reason = "runtime configuration depends on application composition";
    else if (leaf(from) && leaf(to) && leaf(from) !== leaf(to)) reason = "a channel imports another channel implementation";
    else if (independentRoute(from) && independentRoute(to) && from !== to) reason = "independent operation routes import each other";
    else if (from === "src/core/runtime/deadline.ts" && to === "src/core/runtime/read-runtime.ts") reason = "deadline depends on its runtime owner";
    else if (/^src\/core\/runtime\/(observer|store-guard|policy)\.ts$/.test(from) && to === "src/core/runtime/read-runtime.ts") reason = "runtime leaf depends on its state owner";
    else if (/\/contracts\.ts$/.test(from) && to.startsWith("src/core/") && !/\/(contracts|storage-contract)\.ts$/.test(to)) reason = "a contract imports an implementation";
    if (reason) violations.push({ ...edge, reason });
  }
  return violations;
}

function files(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap(entry => entry.isDirectory() ? files(join(directory, entry.name)) : entry.isFile() && entry.name.endsWith(".ts") ? [join(directory, entry.name)] : []);
}
export function inspectCoreBoundaries(root: string) {
  const edges: DependencyEdge[] = [], facadeViolations: BoundaryViolation[] = [];
  const sources = ["src/core", "src/storage", "src/sqlite", "src/postgres"].flatMap(directory => files(join(root, directory)));
  for (const filename of sources) {
    const from = relative(root, filename).split("\\").join("/");
    const source = ts.createSourceFile(filename, readFileSync(filename, "utf8"), ts.ScriptTarget.Latest, true);
    if (/^(?:src\/core\/[^/]+|src\/(?:sqlite|postgres)\/[^/]+)\.ts$/.test(from) && source.statements.some(statement => !ts.isExportDeclaration(statement) && !ts.isEmptyStatement(statement))) {
      facadeViolations.push({ from, to: from, reason: "compatibility entry contains business logic" });
    }
    function visit(node: ts.Node): void {
      let specifier: ts.StringLiteral | undefined;
      if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) && node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier)) specifier = node.moduleSpecifier;
      else if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword && node.arguments[0] && ts.isStringLiteral(node.arguments[0])) specifier = node.arguments[0];
      else if (ts.isImportTypeNode(node) && ts.isLiteralTypeNode(node.argument) && ts.isStringLiteral(node.argument.literal)) specifier = node.argument.literal;
      if (specifier) {
        const to = specifier.text.startsWith(".") ? relative(root, resolve(dirname(filename), specifier.text)).split("\\").join("/").replace(/\.js$/, ".ts") : specifier.text;
        edges.push({ from, to });
      }
      ts.forEachChild(node, visit);
    }
    visit(source);
  }
  return { sources: sources.length, edges: edges.length, violations: [...facadeViolations, ...boundaryViolations(edges)] };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const report = inspectCoreBoundaries(resolve(dirname(fileURLToPath(import.meta.url)), ".."));
  process.stdout.write(JSON.stringify({ ...report, passed: report.violations.length === 0 }, null, 2) + "\n");
  if (report.violations.length) process.exitCode = 1;
}
