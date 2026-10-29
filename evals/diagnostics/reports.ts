import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { latencySummary } from "../baseline/metrics.js";
import { diagnose } from "./analysis.js";
import { type DiagnosticCase } from "./dataset.js";
import { validateReport, type DiagnosticReport } from "./evaluator.js";

export function writeDiagnosticReports(directory: string, report: DiagnosticReport, cases: DiagnosticCase[], comparison: unknown = null) {
  validateReport(report, cases);
  mkdirSync(directory, { mode: 0o700 }); // Refuse to overwrite prior evidence.
  const write = (path: string, value: unknown, markdown = false) => {
    mkdirSync(dirname(join(directory, path)), { recursive: true, mode: 0o700 });
    writeFileSync(join(directory, path), markdown ? String(value) : JSON.stringify(value, null, 2) + "\n", { flag: "wx", mode: 0o600 });
  };
  write("raw-report.json", report); write("gate.json", report.gate); write("comparison.json", comparison);
  const groups = Object.keys(report.summary);
  for (const group of groups) {
    const [backend, partition, endpoint] = group.split("/");
    const rows = report.rows.filter(row => row.backend === backend && row.endpoint === endpoint && cases.find(item => item.id === row.id)!.partition === partition);
    const prefix = `${backend}/${partition}/${endpoint}`;
    const diagnoses = report.diagnostics.filter(row => row.backend === backend && row.endpoint === endpoint && row.partition === partition);
    write(`diagnosis/${prefix}.json`, diagnoses);
    write(`candidates/${prefix}.json`, rows.map(row => ({ id: row.id, round: row.round, repeats: row.observations.map(observation => ({ actual: observation.traces, diagnosticProbe: observation.probes })) })));
    write(`ranking/${prefix}.json`, { meaning: endpoint === "query" ? "actual_query_evidence" : "separate_same_policy_replay_not_actual_response", summary: report.summary[group], rows: rows.map(row => ({ id: row.id, round: row.round, repeats: row.observations.map(observation => ({ ranked: observation.ranked, selected: observation.selected,
      score: diagnose(cases.find(item => item.id === row.id)!, row.endpoint, observation).score })) })) });
    write(`context/${prefix}.json`, rows.map(row => ({ id: row.id, round: row.round, repeats: row.observations.map(observation => ({ selected: observation.selected, budget: observation.budget, contextBytes: observation.contextBytes, omissions: observation.omissions, answer: observation.answer })) })));
    write(`facts/${prefix}.json`, rows.map(row => ({ id: row.id, category: cases.find(item => item.id === row.id)!.category, round: row.round,
      declarationPresent: cases.find(item => item.id === row.id)!.memories.some(spec => Boolean(spec.fact)),
      unannotatedTemporalChallenge: cases.find(item => item.id === row.id)!.category === "temporal_conflict" && !cases.find(item => item.id === row.id)!.memories.some(spec => Boolean(spec.fact)),
      repeats: row.observations.map(observation => observation.factOmissions) })));
    write(`security/${prefix}.json`, { meaning: "output_and_actual_candidates_and_diagnostic_replay_separate; fixture_ineligibility_is_not_proof_of_a_filtered_lexical_match",
      rows: diagnoses.map(row => ({ id: row.id, round: row.round, repeats: row.repeats.map(result => ({ output: result.security, actualCandidates: result.candidateSecurity,
        diagnosticReplay: result.replaySecurity, policyIneligibleUnexposed: result.policyIneligibleUnexposed })) })) });
    write(`stability/${prefix}.json`, { repeat: report.stable.filter(row => rows.some(item => item.id === row.id && item.endpoint === row.endpoint && item.backend === row.backend)),
      rebuild: report.rebuild.filter(row => rows.some(item => row.key === `${item.backend}/${item.endpoint}/${item.id}`)) });
    write(`latency/${prefix}.json`, { note: report.coverage.latency, rows: rows.map(row => ({ id: row.id, round: row.round, latency: latencySummary(row.observations.map(observation => observation.elapsedMs)), errors: row.observations.map(observation => observation.error) })) });
    const exampleRows = rows.filter(row => row.round === 1).map(row => {
      const item = cases.find(item => item.id === row.id)!;
      const diagnosis = diagnose(item, row.endpoint, row.observations[0]!);
      const evidence = row.observations[0]!;
      const safe = (value: string) => value.replace(/[|\n\r]/g, " ");
      const status = row.endpoint === "recall" ? item.recallStatus ?? item.status : item.status;
      return `| ${safe(row.id)} | ${status} | ${evidence.selected.map(record => safe(record.label)).join(", ") || "空"} | ${[...new Set(diagnosis.issues.map(issue => `${issue.stage}/${issue.reason}`))].join(", ") || "无缺口"} |`;
    });
    write(`diagnosis/${prefix}.md`, `# ${group}\n\n每题仅展示第一轮首个响应；三次重建与全部技术重复保存在JSON。正常权限过滤、事实拒绝在各自目录，不算召回收益或异常。\n\n| 问题 | 标准 | 实际选择 | 观察到的缺口 |\n| --- | --- | --- | --- |\n${exampleRows.join("\n")}\n`, true);
  }
  write("README.md", `# 6A逐层诊断报告\n\n虚构问题数：${cases.length}；重建观察行：${report.rows.length}；每行${report.comparable.settings.repeats}技术重复，不放大独立问题数。\n\n工具门禁：${report.gate.passed ? "通过" : "失败"}。它不要求Challenge通过，不代表语义质量达标。验收题已暴露，不是盲测held-out；原生PG/来源认证/workspace/生产SLO未验证。\n\n- [门禁](./gate.json)\n- [完整原始证据](./raw-report.json)\n- [前后对照](./comparison.json)\n\n## 分存储、分数据、分入口\n\n${groups.map(group => `- [${group}](./diagnosis/${group}.md)`).join("\n")}\n\n## 分层查看\n\n候选看candidates/（实际与诊断扩窗分开），排名看ranking/，Context/引用看context/，事实看facts/，权限过滤与泄露看security/，重复/重建稳定看stability/，原始小样例耗时看latency/。没有综合总分。\n`, true);
}
