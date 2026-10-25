# 2C：候选召回验收（2026-10-23）

历史验收：本页数字对应阶段 2 独立候选交付。随后阶段 2 复测通过，按用户授权继续 [阶段 3 公共接入](./phase-3-ranking.md)；新的公共结果见 [阶段 3 验证](./phase-3-validation.md)，不覆盖本页旧数字。

**结论：阶段 2 的 staged Core 候选路径和本地验收完成；公共查询未切换，不自动进入阶段 3。** 质量/安全/稳定性门禁与逐题比较通过；容量只通过响应有效性检查，没有延迟 SLO，也不宣称提速或生产成熟。

设计看 [总览](./phase-2-candidates.md)、[2A 契约](./phase-2a-contract.md)、[2B 通道](./phase-2b-retrievers.md)。本次可移植摘要为 [机器记录](../../evals/baselines/retrieval-core-phase-2c.json)；原始报告、慢样本、命令退出码、首次失败及重试日志保存在仓库外的持久 evidence 目录，不自动提交。

## 量尺、对照与证据完整性

旧临时证据已丢失，本次不伪造恢复历史 checkout。参考与当前使用**相同源码**：`legacy` 是旧 key/list/整句查找的显式投影，`native` 是新候选 API。它是受控的读路径对照，不是完整历史版本回归。公共 RRF/Context 的结果另测，不与单通道指标相减。

- 冻结原 `core-baseline-v1` 的 20 题、原 Recall 标注与 Required/Challenge；新增 `candidate-v1` 的 15 个通道专项单独查看。
- 四存储 × 35 个样例 × 3 次重建，共 420 条逐题记录；每次先预热，再重复 5 次。重复轮次和多个指标不算独立问题。
- 新增报告协议 `open-continuity-candidates-v2`，包含判定标注、实际值/版本、逐次选择、边界标签与覆盖清单。旧 v1 不直接用于新比较。
- `compare.ts` 先校验数据/评测器/锁文件/Node/覆盖指纹，再校验完整样例网格；重算排名、值、pass、泄露与稳定性，不相信报告里已有的 pass 或汇总分。
- 缺行、重复行、预算或标注变化、伪造 pass/排名、原分母为零时新引入的误选均有失败测试。容量比较也重算分位数，拒绝缺轮次、缺操作或样本数量不符。
- 比较得到 **0 退化信号，168 个改善信号，涉及 5 个不同样例**。168 包含跨轮次/指标重复，不能说成 168 项能力或独立缺陷修复。

源码 SHA-256：`0bebde725ffb5dbc68748733b06717c7ea657f4be2fd8d4e9526aa675b2662b8`；评测器：`5dde0264ba9123f2667aa16c7fcf3e64cd5cc9f677ab226d52a137744560e671`；Node `v24.20.0`。数据/锁文件指纹见机器记录。测量期间源码和评测器保持不变；没有读取真实 Agent 历史或默认数据库。

## 召回质量：原标注，单通道

下表只测 `core-baseline-v1/full_text`，正例 Recall/MRR 与 miss/false-selection 各有独立分母。该 workload 遵守样例候选预算，不能与公共融合入口的数字直接混比。

| 存储 | Required | Challenge：旧→新 | Recall@3：旧→新 | MRR@3：旧→新 | miss：旧→新 | false selection：旧→新 |
| --- | --- | --- | --- | --- | --- | --- |
| SQLite | 27/27 → 27/27 | 6/33 → 9/33 | 50.00% → 55.88% | 52.94% → 58.82% | 27/60 → 24/60 | 6/39 → 6/42 |
| InMemory | 27/27 → 27/27 | 6/33 → 6/33 | 50.00% → 50.00% | 52.94% → 52.94% | 27/60 → 27/60 | 6/39 → 6/39 |
| JSON | 27/27 → 27/27 | 6/33 → 6/33 | 50.00% → 50.00% | 52.94% → 52.94% | 27/60 → 27/60 | 6/39 → 6/39 |
| PostgreSQL-pg-mem | 27/27 → 27/27 | 6/33 → 6/33 | 50.00% → 50.00% | 52.94% → 52.94% | 27/60 → 27/60 | 6/39 → 6/39 |

SQLite false-selection 率从 15.38% 到 14.29%，但**错误返回的分子仍是 6**，不是错误数量下降。收益集中在一个旧样例（三轮）：`broad-query-noise-control` 的两个短词通过 AND 找回 target。

### 新增通道专项（与原标注分开）

| 存储 | Exact | Structured：过滤资格覆盖 | Lexical：能力内 Required | 能力外专项 |
| --- | --- | --- | --- | --- |
| SQLite | 9/9 | 9/9 | 旧 15/27 → 新 27/27 | 无 |
| InMemory | 9/9 | 9/9 | 15/15，无变化 | 4 个 SQLite 专项，12 次失败保留 |
| JSON | 9/9 | 9/9 | 15/15，无变化 | 4 个 SQLite 专项，12 次失败保留 |
| PostgreSQL-pg-mem | 9/9 | 9/9 | 15/15，无变化 | 4 个 SQLite 专项，12 次失败保留 |

SQLite 的 4 个专项是词项重排、跨列字面匹配、多短项 AND 与 BM25 优先于时间。其它路径没有这些能力；标注和失败结果不改为通过，适用范围在冻结数据中明确声明。Structured 的 9/9 只证明条件覆盖，不代表 9 次回答相关性成功。

## BM25 消融与事实选择

完整 SQLite 候选集合不变，先关闭 BM25、按时间/id 重排，再截断 K；完整集合超过 100 即报错。此消融不用于生产性能比较。

| 样例 | 旧查找 | 新候选关闭 BM25 | 新候选启用 BM25 | 能归因的变化 |
| --- | --- | --- | --- | --- |
| `broad-query-noise-control` | 空 | target | target | 字面 AND 改变候选集合，不是 BM25 收益 |
| `candidate-bm25-not-recency` | noise | noise | target | 原生相关性顺序压过更新时间 |

确认边界样例的两条合法结果也发生换序，但两条都相关，不包装成质量收益。当前事实选择仍为 **6/9**；不同 key 的 stale 仍可能排在 current 前面。

语义改写、英文同义表达、错字、跨语言、短语不连续、关键词干扰与旧事实选择的失败样例完整保留。BM25 是字面相关性，不是语义理解或事实裁决。

## 权限安全：逐存储、逐通道

四条路径各自生成 security 报告，本次下列分子/分母在每条路径上分别得到相同结果，不将存储分母相加：

| 通道专项 | user | agent | task | private | 显式 requireUserConfirmed |
| --- | --- | --- | --- | --- | --- |
| Exact | 0/3 | 0/3 | 0/3 | 0/3 | 0/3 |
| Structured | 0/3 | 0/3 | 0/6 | 0/3 | 0/6 |
| Lexical | 0/3 | 0/3 | 0/3 | 0/3 | 0/6 |

原基线的 Recall 策略不强制确认，确认分母为 **0/0，未覆盖**；不能写成确认门禁通过。测试身份是显式虚构输入，不证明入口认证或端到端提示词攻击防护。workspace 未重验；SQLite 全表 BM25 统计也不提供跨用户统计侧信道隔离。

## 稳定性

每存储的原基线单通道：同库重复 60/60，三次重建按 label 列表比较为 20/20。新增 Exact、Structured、Lexical 分别为重复 9/9、9/9、27/27；重建 3/3、3/3、9/9。各存储报告独立保留。

同库稳定、夹具重建稳定，不等于并发 snapshot 或等时间随机 UUID 的跨数据库全序。稳定选错仍是失败。

## 容量性能：保留成本，不设漂亮总分

在质量测试结束后串行测 SQLite 1k/10k，各三轮；每操作预热 10 次后测 200 次。每路径 4,800 个测量样本全部保留，响应错误均为 0。下表为各轮 P95 范围（ms），P50/P99 及原始样本另存：

| 容量 | 操作 | 旧查找投影 P95 | 新候选 P95 |
| --- | --- | --- | --- |
| 1k | Exact | 0.152–0.156 | 0.140–0.173 |
| 1k | Structured | 0.064–0.078 | 0.060–0.069 |
| 1k | Lexical | 0.248–0.277 | 0.281–0.304 |
| 1k | 短查询 | 0.058–0.061 | 0.058–0.064 |
| 10k | Exact | 2.100–2.725 | 1.756–2.466 |
| 10k | Structured | 0.066–0.092 | 0.061–0.090 |
| 10k | Lexical | 0.879–1.006 | 1.075–1.303 |
| 10k | 短查询 | 0.057–0.065 | 0.057–0.061 |

文本相关性路径有可见延迟成本，未隐藏或删除慢轮次；其它操作的更低样本也不算统计显著提速。没有延迟 SLO，不能把响应有效性通过写成“严格无性能回归”。小夹具 legacy 投影先取完整集合再做确认/预算，新路径直接 top-K；其耗时只作描述，不作为公平生产速度结论。

公共 `benchmark:lite` 是另一 workload：10k/100 次，Exact/FTS/Context P95 为 **1.768 / 3.429 / 3.556 ms**；Exact 最大 12.188 ms 仍保留。它没有本次历史版本对照，不与上表互换。

## 公共 Recall 与 Context：独立兼容检查

公共入口未切换，新候选收益不能宣称成公共查询收益。本次固定公共基线中，SQLite Recall Required 27/27、Challenge 6/33，Recall@3 61.76%、MRR@3 58.82%，miss 21/60、false selection 6/45。Context Required 30/30、Challenge 6/30，Recall@3/MRR@3 均 52.94%，miss 24/54、false injection 6/36。

旧 `quality-v1` 的 Required 15/15、Challenge 7/42、miss 23/36；其 false injection 为 0/5，但旧 evaluator 对 forbidden distractor 有盲区，不能替代上面的 Context 6/36。时间/UUID 导致的旧 Challenge 波动不算本阶段收益。

## 工程命令与恢复

| 检查 | 本次结果 |
| --- | --- |
| `npm run typecheck` | 通过 |
| 受影响的五个测试文件 | 141 passed / 1 skipped |
| `npm test`（含 build） | 41 文件，282 passed / 37 skipped |
| 候选专项与评测器自测 | 52/52（包含在上述测试中，不重复加总） |
| `npm run eval:suite` | 185/185，泄露 0/40；P95 4.820 ms |
| `npm run eval:quality` | Required 15/15，Challenge 7/42 |
| `eval:candidates --mode=legacy --capacity` | 预期 exit 1：4 个新能力样例 × 3 轮失败；无执行/泄露/稳定性错误，容量响应有效 |
| `eval:candidates --compare=... --capacity` | exit 0，420 条逐题比较通过；容量样本校验通过，无延迟门禁 |
| `eval:baseline --capacity` | 公共质量/安全/稳定性与容量响应有效性通过 |
| `npm run benchmark:lite` | 完成，样本和高尾保留 |
| 原生 PostgreSQL 隔离入口 | 首次因本机 Docker 未启动失败；启动已安装服务后重试 36/36，版本 17.11，容器已清理 |
| `git diff --check` | 通过 |

默认跳过的 36 项 PG 已通过独立原生入口执行；剩余 1 项为 pg-mem JSON 键限制，对应原生断言通过。不是声称显式 PG 全量矩阵已运行。首次失败、重试日志与清理确认均保留，不把失败覆盖成一次成功。

## 复现与证据保存

选择一个新的持久目录 `<evidence-dir>`，不要放在默认数据库或真实 Agent 历史目录，也不要覆盖旧报告：

```bash
npm run eval:candidates -- --mode=legacy --report-dir=<evidence-dir>/reference --capacity
# 旧路径未实现本次新能力，因此预期非零退出；先检查具体失败原因。
npm run eval:candidates -- --report-dir=<evidence-dir>/current --compare=<evidence-dir>/reference/raw-report.json --capacity
npm run typecheck
npm test
npm run eval:suite
npm run eval:quality
npm run eval:baseline -- --report-dir=<evidence-dir>/public --capacity
npm run benchmark:lite
# 显式选择一次性本地原生 PG，不复用现有数据库：
npm run test:storage:postgres:docker
```

索引分别链接 quality/security/stability/latency/ablation；comparison.json、capacity.json、capacity-comparison.json 单独查看。原始逐题记录包含合法的虚构观察；manifest 记录每份证据的 SHA-256。持久本地目录不是远端 CI 归档，仍需用户备份。仓库只保存小型、无真实路径/凭据/用户数据的机器摘要。

仍缺独立保留集、原生 PG 检索质量、workspace 端到端、长期并发、重启/断电、跨平台/版本发布矩阵与性能 SLO；未引入模型、embedding 或新 Adapter。2C 没有修改生产 Core 查询行为。没有 commit/push；是否进入阶段 3 需要人工确认。
