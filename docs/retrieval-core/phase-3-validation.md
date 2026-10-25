# 阶段 2 复测与阶段 3 首个增量验收（2026-10-23）

历史验收：本页保留 3A/3B 首个增量的原始数字；后续显式事实模式见 [3C 验收](./phase-3c-validation.md)，不覆盖旧证据。

**阶段 2 复测通过；阶段 3 公共接入与确定性排名完成本地验证。跨 key 事实裁决和性能 SLO 未完成，阶段 3 尚未整体完成。** [设计](./phase-3-ranking.md) 与 [机器摘要](../../evals/baselines/retrieval-core-phase-3-first-increment.json)分开查看。

## 工程与候选复测

阶段 2 源码在复测期间冻结，保留副本及原始报告；类型检查、受影响测试、全量、suite、quality、候选比较、公共基线/容量、benchmark 和一次性原生 PG 均成功。

| 检查 | 阶段 2 复测 | 阶段 3 最终代码 |
| --- | --- | --- |
| typecheck / build | 通过 | 通过，新增 ranking evaluator 也纳入类型检查 |
| npm test | 282 passed / 37 skipped | 43 文件，312 passed / 37 skipped |
| 原生 PostgreSQL 隔离入口 | 36/36 | 36/36；测试资源清理 |
| eval:suite | 185/185 | 185/185；泄露 0/40；P95 2.489 ms |
| eval:quality | Required 15/15，Challenge 8/42 | Required 15/15，Challenge 9/42 |
| eval:candidates compare | 上轮 native 对照通过 | 420 条单通道记录、0 退化 |
| eval:baseline compare + capacity | 公共基线通过 | 480 条公共记录、比较通过，容量响应有效 |
| eval:ranking | 尚无 | 4 机制样例，默认通过；关闭信号失败保留 |
| benchmark:lite | 完成 | 完成，全部高尾保留 |

跳过项不算通过；默认跳过的 36 项原生 PG 已单独运行，另 1 项为模拟器 JSON 键限制。原生 PG 结果仅是存储/候选工程证据；新增公共 PG 质量/排名仍用 pg-mem。

开发途中先遇到一项旧测试对 taskId-only Structured channel 的预期不符，按新职责更新并增加 skipped 断言。新增 Query 来源测试随后发现首步信号重复附加，已修复，四存储验证每个 signal 只附加一次且带 query/stepId。开发失败的原始输出在当前任务工具记录中，本地另存失败摘要；最终验证日志单独保留。

## 公共质量：原标注、同量尺

冻结 core-baseline-v1，4 存储 × 20 题 × 2 入口 × 3 重建 = 480 条观察。原标注、评测器、依赖锁、Node 保持一致。另行校验完整样例网格并从选择列表重算 Recall/MRR/nDCG/miss/误选；0 质量退化。9 条选择列表发生变化，涉及 2 个不同样例，不是 9 项能力收益。

| SQLite 公共指标 | 阶段 2 | 阶段 3 首个增量 |
| --- | --- | --- |
| Recall Required / Challenge | 27/27；6/33 | 27/27；9/33 |
| Recall@3 / MRR@3 / nDCG@3 | 61.76% / 58.82% / 56.89% | 67.65% / 64.71% / 62.77% |
| Recall miss / false selection | 21/60；6/45 | 18/60；6/48 |
| Context Required / Challenge | 30/30；6/30 | 30/30；9/30 |
| Context Recall@3 / MRR@3 / nDCG@3 | 52.94% / 52.94% / 51.75% | 58.82% / 58.82% / 57.63% |
| Context miss / false injection | 24/54；6/36 | 21/54；6/39 |

收益集中在 `broad-query-noise-control`：阶段 2 的字面 AND 能力正式进入公共调用。`boundary-unconfirmed-exact` 的两个合法 Recall 结果换序，但二者均合法相关，不算质量收益。错误分子仍为 **6**，比率下降由分母增加，不能说误选数量减少。InMemory、JSON、PostgreSQL-pg-mem 的公共质量不变，各自报告保留。

质量报告 v1 没有完整独立的实际值/版本观察，无法从报告重新验证 valuesMatch；版本/值语义由跨存储契约测试验证。不能把新摘要当成 v2 评测协议升级。旧 quality-v1 false injection 0/6 有 forbidden distractor 盲区，不替代上述 6/39。

## 安全与稳定性

各存储、各入口独立：user/agent/task/private 各 0/3；确认-required Context 为 0/6；Recall 确认为 0/0 未覆盖。新增四存储公共测试另外覆盖确认-before-budget、Query、畸形/跨身份/跨排序策略游标、无证据不补候选和当前版本。它们不提供入口认证或 workspace 端到端证明。

每存储、每入口同库重复 60/60，三次重建按 label 顺序为 20/20。随机 UUID 跨库全序、并发 snapshot 和真实断线未覆盖。SQLite 全表 BM25 统计没有跨用户统计侧信道隔离。

## 消融与事实选择

`eval:ranking` 分别保存 quality/ablation/stability。4 个固定虚构证据矩阵、4 变体、5 次重复只是机制检查；不计成 80 个独立问题。关 BM25 同集合按时间排序会让 newer-noise 先入选；关 exact tier 会使文本候选挤出第二个 exact；RRF 专项两臂均关 exact tier，关 RRF 后重合证据失去优势；filter-only 始终不补候选。失败结果保留。

SQLite 原始分数与 native order 的公共一致性另有真实临时数据库测试。当前事实选择仍 **6/9**：同 key 的 current/supersedes 语义有验证，不同 key 的 stale/current 未解决；混合版本拒绝是工程一致性，不是事实裁决。语义改写、跨语言、错字、否定与关键词干扰保留为 Challenge。

## 性能：观察有效，但未通过延迟门禁

benchmark:lite 同机 10k/100 次、无独立预热：

| 操作 | 阶段 2 P95 ms | 最终代码 P95 ms | 最终最大 ms |
| --- | --- | --- | --- |
| Exact key | 1.753 | 2.935 | 3.810 |
| FTS | 3.126 | 3.483 | 12.336 |
| Context | 3.622 | 3.208 | 7.314 |

Exact 高尾触发补查：从本轮阶段 2 私有源码副本与最终代码读取同一虚构 10k 数据库的副本，各三轮，先预热 10 次、采样 200 次，交替旧/新运行顺序。仅此 workload 的各轮 P95 范围：

| 操作 | 旧代码 P95 ms | 最终代码 P95 ms | 最终最大 ms |
| --- | --- | --- | --- |
| Exact key | 2.166–2.701 | 2.749–5.692 | 16.762 |
| Full Text | 3.765–7.545 | 3.662–4.035 | 8.919 |
| Context | 3.783–5.439 | 3.156–4.653 | 8.803 |

补查所有操作响应有效；全部 3,600 个样本保留。Exact 非 query 调用直接委托 Store，相关源码与旧快照一致，观测高尾原因尚未确定。较低的其它样本不算统计显著提速。原始 benchmark、补查与基线容量是不同 workload，不混比；容量响应有效不等于性能无回归。后续需要独立性能 SLO、重复受控环境及高尾归因。

## 复现与保存

```bash
npm run typecheck
npm test
npm run eval:suite
npm run eval:quality
npm run eval:candidates -- --report-dir=<new-candidate-dir> --compare=<phase2-candidate-report>
npm run eval:baseline -- --report-dir=<new-public-dir> --compare=<phase2-public-report> --capacity
npm run eval:ranking -- --report-dir=<new-ranking-dir>
npm run benchmark:lite
npm run test:storage:postgres:docker
```

最终源码 SHA-256：`235fbb313cd5b1562fd95494364c6065e6c95f5e28b29b396bce0a07505f1200`；阶段 2：`0bebde725ffb5dbc68748733b06717c7ea657f4be2fd8d4e9526aa675b2662b8`。源代码、评测器在最终测量期间冻结。持久本地 evidence 目录保留 444 份报告/日志的 SHA-256 清单，开发失败摘要另存；源码副本和依赖链接只在仓库外，不自动提交。机器摘要无真实路径或用户数据，持久本地证据仍需用户备份。

本轮未修改 Adapter/Capture/Injection/Agent CLI 配置，未 commit/push。下一增量为 3C 的事实组/有效性/冲突与不确定性设计；阶段 4 Context/Answer、原生 PG 公共质量、远端发布矩阵和性能门禁仍未完成。
