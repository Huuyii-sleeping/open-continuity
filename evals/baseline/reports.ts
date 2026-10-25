import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { BaselineReport, Backend } from "./evaluator.js";
import type { compareReports } from "./compare.js";
import type { measureCapacity } from "./performance.js";
import { mean, ratio, type Ratio } from "./metrics.js";

type Comparison = ReturnType<typeof compareReports> | null;
type Capacity = Awaited<ReturnType<typeof measureCapacity>> | null;
const display = (value: Ratio) => value.value === null ? "未覆盖" : `${(value.value * 100).toFixed(2)}% (${value.numerator.toFixed(2)}/${value.denominator})`;
const state = (passed: boolean) => passed ? "通过" : "失败";

export function writeSplitReports(root: string, report: BaselineReport, comparison: Comparison, capacity: Capacity) {
  // An evidence directory is immutable for this run; never overwrite previous evidence.
  mkdirSync(root, { mode: 0o700 });
  const entries: string[] = [];
  const write = (path: string, content: string) => {
    mkdirSync(dirname(join(root, path)), { recursive: true, mode: 0o700 });
    writeFileSync(join(root, path), content, { flag: "wx", mode: 0o600 });
    entries.push(path);
  };
  const json = (path: string, value: unknown) => write(path, JSON.stringify(value, null, 2) + "\n");
  // Kept only for exact machine comparison. Human entry points are the separate reports below.
  json("raw-report.json", { ...report, comparison, capacity });
  json("gate.json", { qualitySafetyStability: report.gate, comparison: comparison ? { passed: comparison.passed, regressions: comparison.regressions } : "未运行", capacityValidity: capacity?.validityPassed ?? "未运行" });

  for (const backend of report.coverage.backends) {
    for (const endpoint of ["recall", "context"] as const) {
      const rows = report.rows.filter((row) => row.backend === backend && row.endpoint === endpoint);
      const groups = Object.fromEntries(["required", "challenge"].map((status) => {
        const group = rows.filter((row) => row.status === status);
        return [status, {
          distinctCases: new Set(group.map((row) => row.id)).size,
          passRate: ratio(group.filter((row) => row.passed).length, group.length),
          atK: Object.fromEntries(report.comparable.settings.ks.map((k) => [String(k), {
            recall: mean(group.map((row) => row.ranking.atK[String(k)]!.recall.value)),
            mrr: mean(group.map((row) => row.ranking.atK[String(k)]!.reciprocalRank)),
            ndcg: mean(group.map((row) => row.ranking.atK[String(k)]!.ndcg)),
          }])),
          missRate: ratio(group.reduce((sum, row) => sum + row.ranking.miss.numerator, 0), group.reduce((sum, row) => sum + row.ranking.miss.denominator, 0)),
          falseSelectionRate: ratio(group.reduce((sum, row) => sum + row.ranking.falseSelection.numerator, 0), group.reduce((sum, row) => sum + row.ranking.falseSelection.denominator, 0)),
        }];
      }));
      const observations = rows.map(({ id, category, status, round, selected, ranking, passed, valuesMatch, error }) => ({ id, category, status, round, selected, ranking, passed, valuesMatch, error }));
      const prefix = `${endpoint}/${backend}`;
      json(`${prefix}.json`, { groups, observations });
      let markdown = `# ${backend} · ${endpoint === "recall" ? "召回质量" : "Context 选择质量"}\n\n只评估本层质量；安全、稳定性和性能请查看独立报告。Required 与 Challenge 分开，禁止用总平均掩盖退化。\n\n`;
      for (const status of ["required", "challenge"]) {
        const group = groups[status]!;
        markdown += `## ${status}\n\n独立样例：${group.distinctCases}；通过率：${display(group.passRate)}。重复轮次不等于独立样例。\n\n| K | Recall@K | MRR@K | nDCG@K |\n| --- | --- | --- | --- |\n`;
        for (const k of report.comparable.settings.ks) {
          const score = group.atK[String(k)]!;
          markdown += `| ${k} | ${display(score.recall)} | ${display(score.mrr)} | ${display(score.ndcg)} |\n`;
        }
        markdown += `\nMiss rate：${display(group.missRate)}。${endpoint === "context" ? "False injection" : "False selection"} rate：${display(group.falseSelectionRate)}。\n\n`;
      }
      markdown += "## 逐样例结果（首轮）\n\n| 样例 | 类别 | 状态 | 选择顺序 | 结果 |\n| --- | --- | --- | --- | --- |\n";
      for (const row of rows.filter((row) => row.round === 1)) markdown += `| ${row.id} | ${row.category} | ${row.status} | ${row.selected.join(" → ") || "空"} | ${state(row.passed)} |\n`;
      markdown += `\n[全部轮次与指标分子/分母](${backend}.json)。当前/旧事实：${display(report.summary[`${backend}/${endpoint}`]!.currentFactSelection)}。\n`;
      write(`${prefix}.md`, markdown);
    }

    const security = ["recall", "context"].map((endpoint) => ({ endpoint, leakage: report.summary[`${backend}/${endpoint}`]!.leakage }));
    json(`security/${backend}.json`, { boundaries: security, observations: report.rows.filter((row) => row.backend === backend).map(({ id, round, endpoint, leakage, error }) => ({ id, round, endpoint, leakage, error })), workspace: "未覆盖：由 Adapter/Injection 层实施", postgres: backend === "postgres-pg-mem" ? "仅模拟，真实 PostgreSQL 未验证" : undefined });
    let securityMarkdown = `# ${backend} · 权限安全\n\n| 边界 | Recall 泄露/暴露数 | Context 泄露/暴露数 |\n| --- | --- | --- |\n`;
    for (const boundary of ["user", "agent", "task", "private", "userConfirmed"]) securityMarkdown += `| ${boundary} | ${display(security[0]!.leakage[boundary]!)} | ${display(security[1]!.leakage[boundary]!)} |\n`;
    securityMarkdown += `\nRecall 允许未确认记忆；其 userConfirmed 分母为 0，显示“未覆盖”，不能写成“零泄露”。Workspace 在本内核报告中未覆盖。\n\n[逐项安全观测](${backend}.json)\n`;
    write(`security/${backend}.md`, securityMarkdown);

    const stability = ["recall", "context"].map((endpoint) => {
      const summary = report.summary[`${backend}/${endpoint}`]!;
      return { endpoint, repeat: summary.repeatStability, rebuild: summary.rebuildStability };
    });
    json(`stability/${backend}.json`, { measurements: stability, observations: report.rows.filter((row) => row.backend === backend).map(({ id, round, endpoint, selected, stable }) => ({ id, round, endpoint, selected, stable })), sameTimestampTieRebuild: "未覆盖" });
    write(`stability/${backend}.md`, `# ${backend} · 排序稳定性\n\n| 入口 | 同库重复查询 | 重新建库 |\n| --- | --- | --- |\n${stability.map((item) => `| ${item.endpoint} | ${display(item.repeat)} | ${display(item.rebuild)} |`).join("\n")}\n\n写入之间间隔 2 ms，固定相对时间顺序。相同时间戳与随机 UUID tie-break 的跨建库稳定性未覆盖。\n\n[全部轮次顺序](${backend}.json)\n`);
  }

  let performanceMarkdown = "# 容量性能\n\nSQLite、串行、单进程；每个容量重新建库三轮，每个操作先预热 10 次再测量 200 次。原始延迟保留，P99 是描述值，尚未建立性能 SLO 或跨机器门禁。\n\n";
  if (capacity) {
    performanceMarkdown += "| 容量 | 轮次 | 操作 | P50 ms | P95 ms | P99 ms | 错误响应 | 明细 |\n| --- | --- | --- | --- | --- | --- | --- | --- |\n";
    for (const result of capacity.results) {
      const path = `performance/size-${result.size}/run-${result.run}.json`;
      json(path, { workload: capacity.workload, settings: capacity.settings, result });
      for (const sample of result.samples) performanceMarkdown += `| ${result.size} | ${result.run} | ${sample.operation} | ${sample.p50?.toFixed(3)} | ${sample.p95?.toFixed(3)} | ${sample.p99?.toFixed(3)} | ${sample.invalidResponses}/${sample.count} | [原始样本](size-${result.size}/run-${result.run}.json) |\n`;
    }
  } else performanceMarkdown += "未运行容量基准。使用 --capacity；小夹具的延迟不能替代容量性能。\n";
  write("performance/README.md", performanceMarkdown);
  write("engineering/README.md", "# 工程可靠性\n\n本命令不执行工程测试，本报告状态为未运行。请独立运行 typecheck、npm test、eval:suite；事务、CAS、幂等、分页、迁移和故障恢复的证据必须保留测试名称、命令和结果。历史审计快照见仓库 docs/retrieval-core/phase-0-baseline.md，不能当成本次执行结果。\n");
  if (comparison) {
    for (const backend of report.coverage.backends) for (const endpoint of ["recall", "context"]) json(`comparison/${endpoint}-${backend}.json`, { regressions: comparison.regressions.filter((item) => item.observation.startsWith(`${backend}/${endpoint}/`)), deltas: comparison.deltas.filter((item) => item.observation.startsWith(`${backend}/${endpoint}/`)) });
    write("comparison/README.md", `# 同口径回归比较\n\n结果：${state(comparison.passed)}；退化信号：${comparison.regressions.length}。\n\n${report.coverage.backends.flatMap((backend) => ["recall", "context"].map((endpoint) => `- [${backend}/${endpoint}](${endpoint}-${backend}.json)`)).join("\n")}\n\n${comparison.note}\n`);
  }
  const links = (category: string) => report.coverage.backends.map((backend: Backend) => `[${backend}](${category}/${backend}.md)`).join(" · ");
  write("README.md", `# Retrieval Core 基线结果\n\n源码：${report.evidence.commit}；独立样例：${report.coverage.distinctCases}。完整来源、指纹与覆盖范围见 [manifest](manifest.json)。\n\n| 检查项 | 查看结果 |\n| --- | --- |\n| 召回质量 | ${links("recall")} |\n| Context 选择 | ${links("context")} |\n| 权限安全 | ${links("security")} |\n| 排序稳定性 | ${links("stability")} |\n| 容量性能 | [逐容量、逐轮结果](performance/README.md) |\n| 工程可靠性 | [执行状态与独立命令](engineering/README.md) |\n${comparison ? "| 同口径比较 | [逐存储、逐入口退化](comparison/README.md) |\n" : ""}\n质量/安全/稳定性门禁：${state(report.gate.passed)}；${comparison ? `回归比较：${state(comparison.passed)}；` : "回归比较：未运行；"}容量响应校验：${capacity ? state(capacity.validityPassed) : "未运行"}。没有综合总分。[门禁失败明细](gate.json)。\n`);
  json("manifest.json", { format: report.format, evidence: report.evidence, comparable: report.comparable, environment: report.environment, coverage: report.coverage, files: entries });
}
