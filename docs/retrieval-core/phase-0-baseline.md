# Retrieval Core 阶段 0 基线

记录日期：2026-10-12（Asia/Shanghai）

基线提交：`e23207aa9e746c71a599af8e2a0c913c5d59bf94`

来源：干净的 detached `core-v2` 分叉点工作树；该提交是阶段开始时的 `origin/main`

环境：macOS arm64，Node.js `v24.20.0`

## 隔离方式

基线运行在独立的 `open-continuity-phase0-baseline` 工作树，该工作树固定指向 `e23207aa9e746c71a599af8e2a0c913c5d59bf94`，不包含：

- `codex/core-v2` 中未提交的 Retrieval Core v2 Spike；
- `codex/adapter-hardening` 工作区的未提交修改；
- 用户默认数据库、真实 Agent 历史、日志或配置。

所有测试和评测只使用仓库内虚构数据以及测试创建的临时 SQLite/JSON/pg-mem 数据库。

阶段运行期间，当前 `origin/main` 合入 Adapter hardening 后前进到 `9abe30956b67a99ff44fce11713c5838cfa364b0`。其差异集中在 Adapter、Capture、Injection、CLI 及相关评测，没有修改 Retrieval Core 源码。为遵守“不混入 Adapter 加固”的边界，本阶段没有更新基线提交；阶段 1 开始前需要先决定如何吸收最新上游。

## 工程基线

此文件保留首次审计快照；后续补强使用独立 `core-baseline-v1` 口径，见 [可执行基线与独立报告](./baseline-framework.md)。两者数字不能直接相减。阶段 0 验收应检查可运行机制和未覆盖项，而不只检查本表。

| 命令 | 结果 |
| --- | --- |
| `npm ci` | 219 packages；audit 发现 0 vulnerabilities |
| `npm run typecheck` | 通过 |
| `npm test` | 35 个测试文件、141 个测试全部通过 |
| `npm run eval:suite` | 185/185 通过 |
| `npm run eval:quality` | required 门禁通过；challenge 大量失败 |
| `npm run benchmark:lite` | 完成 10,000 条虚构 Memory 基准 |

`npm ci` 报告 `esbuild` 和 `fsevents` 的 install script 尚未纳入 npm allowScripts。这不是本阶段的 RAG 行为变化，但应在发布门禁中单独处理。

## 正式 Suite 基线

数据集：`suite-v1`，5 轮。

| 指标 | 结果 |
| --- | ---: |
| Capture | 90/90 |
| Injection | 65/65 |
| Governance | 30/30 |
| 总计 | 185/185 |
| 安全泄露 | 0/40 |
| 端到端延迟 P50 | 2.094 ms |
| 端到端延迟 P95 | 2.957 ms |
| 端到端延迟 P99 | 4.217 ms |
| 最大延迟 | 4.217 ms |

解释：该结果证明现有虚构场景中的 Capture、Injection、治理和边界门禁稳定；它不证明检索排序成熟。

## Quality-v1 基线

数据集：`quality-v1`，3 轮。

| 指标 | 结果 |
| --- | ---: |
| Required pass rate | 15/15，100% |
| 全量 pass rate | 21/57，36.84% |
| Challenge pass rate | 6/42，14.29% |
| Security leakage rate | 0/6，0% |
| Miss rate | 24/36，66.67% |
| 报告的 false injection rate | 0/6，0% |
| 评测延迟 P50 | 0.172 ms |
| 评测延迟 P95 | 0.284 ms |
| 最大延迟 | 1.140 ms |

### 通过的检索能力

- 完整短语的精确相似匹配；
- 同 key 最新版本替换；
- JSON merge 后的当前版本；
- private 和未确认记忆在质量评测的 Context Policy 下不泄露；
- 否定查询不匹配正向事实的单个挑战样例。

### 稳定失败的挑战

- 短查询高重叠；
- 近义改写和英文同义表达；
- typo tolerance；
- 跨语言等价；
- 宽泛查询的噪声控制；
- 高重叠候选的真实相关性排序；
- 不同 key 的当前事实与旧事实选择；
- Capture 的否定、引用语境和多信号拆分。

### 指标解释限制

当前 `quality-v1` 评测器没有计算 Recall@K、MRR、nDCG 或排序稳定性。它的 `falseInjectionRate` 只统计“既非 relevant 也非 forbidden”的意外项；被标注为 forbidden 的错误候选不会进入该分子。因此，即使排序挑战选择了明确的 distractor，报告仍可能显示 false injection 为 0。

阶段 0 冻结原始数字，但禁止把该 false injection 数值单独用作成熟度证据。阶段 2/3 必须先修正指标定义，再把新口径与本基线并列报告，不能覆盖旧口径。

## Lite 性能基线

数据：10,000 条完全虚构 Memory，10,000 个事件，100 次查询迭代。

| 项目 | 结果 |
| --- | ---: |
| SQLite 文件大小 | 19,103,744 bytes |
| Seed 总耗时 | 6,831.033 ms |
| 写入吞吐 | 1,463.907 writes/s |
| Exact key P50 / P95 / Max | 1.838 / 2.032 / 5.702 ms |
| FTS recall P50 / P95 / Max | 3.260 / 3.819 / 8.368 ms |
| Context Pack P50 / P95 / Max | 3.430 / 3.949 / 4.860 ms |

该结果是单机合成基准，不是跨机器性能承诺。现有 benchmark 没有覆盖百万级数据、并发查询、写读竞争、迁移、崩溃恢复或 P99 长尾。

## 阶段 0 结论

1. 安全与工程门禁目前较强：正式 Suite 通过，已覆盖的泄露率为 0。
2. 检索质量明显不足：challenge 通过率 14.29%，miss rate 66.67%。
3. 当前系统能“命中”，但不能证明会“按真实相关性排序”。
4. 当前评测无法完整回答排序是否改善，必须在阶段 2/3 引入分层指标和消融实验。
5. 任何后续优化都必须与本基线比较，并说明变化来自召回、排序、Context 还是回答层。
