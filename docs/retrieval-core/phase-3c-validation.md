# 3C：显式事实模式验收（2026-10-23）

**本轮交付已完成本地验收：可见事实组、有效期与精确替代版本核实，冲突/缺证据省略，Query 最终核实，以及声明的跨存储/包迁移。** 不是语义真伪判断，也不是生产成熟度或完整 RAG 的证明。设计见 [3C](./phase-3c-fact-design.md)，[可移植机器摘要](../../evals/baselines/retrieval-core-phase-3c.json)与原始本地证据分开。

## 工程命令

| 检查 | 最终冻结版本 |
| --- | --- |
| typecheck / build | 通过 |
| npm test | 368 passed，0 failed，48 skipped |
| 原生 PostgreSQL 17.11 | 47/47；一次性 loopback/tmpfs 实例已清理 |
| eval:suite | 185/185；泄露 0/40；P95 2.358ms |
| eval:quality | Required 15/15，Challenge 9/42；旧 forbidden-distractor 盲区保留说明 |
| eval:candidates | 420 条比较通过，0 退化 |
| eval:ranking | 默认 4/4；关闭信号的失败仍保留 |
| eval:baseline --compare --capacity | 480 条原公共观察，0 排名指标变化/退化；容量响应有效 |
| eval:facts --compare --capacity | 192 行通过，质量/安全/稳定/延迟/容量独立保存 |
| benchmark:lite | 前/后同 workload 均完成，见下表 |

默认跳过的 47 项 PG 已在原生入口另跑；剩余 1 项是 pg-mem JSON 键限制。原生 PG 工程结果不替代原生检索质量或 Team 发布矩阵。

最终源码 SHA-256：`aeac8cffbef938519938f8bc99272a94df8402d06e6acfec74e360e6dc9598ed`；参考 3A/3B 源码：`235fbb313cd5b1562fd95494364c6065e6c95f5e28b29b396bce0a07505f1200`。Node `v24.20.0`。最终命令串行运行并逐次确认源码未变化；所有数据完全虚构。兼容性最后补验包含旧 Store 写前拒绝、实际能力不支持与声明回执丢失检测；先前轮次均保留，不冒充最终版本。

## 原公共基线：没有伪造语义收益

原 core-baseline-v1 标注与预算不变，四存储的原公共排名指标未变化。SQLite 的汇总为：

| 原指标 | 3A/3B → 3C |
| --- | --- |
| Recall@3 / MRR@3 | 67.65% / 64.71% → 不变 |
| Recall nDCG@3 / miss | 62.77% / 18/60 → 不变 |
| Recall false selection | 6/48 → 不变 |
| Context Recall@3 / MRR@3 | 58.82% / 58.82% → 不变 |
| Context nDCG@3 / miss | 57.63% / 21/54 → 不变 |
| Context false injection | 6/39 → 不变 |
| 当前事实选择 | 6/9 → 不变；未声明的跨 key stale/current 仍失败 |

这里没有为旧样例补写 fact、改相关性标注或把未知结果硬编码为通过。旧 quality-v1 的 false injection 0/6 存在盲区，不能替代 Context 6/39。

## 新 fact-v1：显式契约能力

8 个不同虚构样例 × 4 存储 × 3 次重建 × Recall/Context，共 192 行，每次先预热后重复 5 次；不是 192 个独立问题。分别覆盖旧数据控制、明确替代、query 之外的可见冲突、过期/未来、字面一致性、权限分区、替代者不匹配 query。

- 每存储 Recall 24/24，miss 0/21、false selection 0/21；Context 24/24，miss 0/18、false injection 0/18。拒答类样例没有正例分母，不混入 Recall/MRR 分母。
- 同库顺序重复全部稳定；重建另比较成员集合，不证明等时间随机 UUID 的跨库全序。重建稳定选错仍会因质量判断失败。
- 每存储/入口，user/agent/task/private 各 0/3；确认-required Context 0/3。普通 Recall 的确认分母 0/0 是未覆盖，因为其原策略允许未确认记忆；workspace/入口认证不在本夹具。
- 旧源码仅能保留旧数据控制，其余声明/回执契约尚不存在；这是新契约缺失，不是历史线上缺陷数，也不提供 held-out 或真实问题泛化结论。

额外工程测试验证：按 key 查询仍核实整个授权组、不新增非 query 候选；跨 scope/kind 隔离；循环/失效/被遗忘引用；组截断和存储错误；中途变化的 Query 累计声明最终重查；SQLite 最后事件投影失败回滚；JSON/SQL/Package 保留声明与引用；含冒号的 taskId/key 不在包物化时折叠。Store 与 transfer 共用兼容 codec，声明格式禁止静默降级。

## 性能：保留成本与慢样本

以下是不同 workload，不能互换数字。没有 latency SLO、统计提速或严格无回归结论。

| benchmark:lite，10k / 100次 | 前 P95 ms | 后 P95 ms |
| --- | --- | --- |
| 无 query 的 Exact key | 2.035 | 2.155 |
| FTS Recall | 4.766 | 4.183 |
| Context | 4.096 | 4.552 |

它只有一次汇总测量、没有独立预热；FTS 前/后最大 9.805/7.878ms 保留。更低的 P95 不能宣称统计提速；Exact/Context 的增加也不能藏掉。

独立声明成本 workload 为 SQLite 1k/10k，各三轮、每操作预热10次/测200次；每臂2400个原样本保留。single_group 只核实1个组，many_groups 有50个候选/不同组：

| 容量 / 操作 | 前各轮 P95 范围 ms | 后各轮 P95 范围 ms |
| --- | --- | --- |
| 1k / single_group | 0.941–1.006 | 0.737–1.132 |
| 1k / many_groups | 1.965–4.159 | 3.503–3.948 |
| 10k / single_group | 2.907–3.673 | 3.616–6.807 |
| 10k / many_groups | 17.926–19.789 | 23.028–28.325 |

10k single_group 后最大20.462ms；many_groups 前/后最大50.592/57.519ms，全保留。前源码不具备声明核实，这张表表达新增验证成本，不是同能力的纯速度竞争；查询验证也计入耗时。最后轮次与旧轮次均保存，本机噪声和高尾原因未被证明。

## 证据与剩余边界

原始命令退出码、各轮样本、逐题观察、来源/数据/评测器指纹、首次失败和重试保存在仓库外持久目录，SHA-256 清单另存；小型摘要不包含真实路径、用户数据或内部文档链接。开发途中类型/格式问题、Docker PATH 失败、文档插图 partial_success 和最终修复均如实保留，旧轮次不冒充最终证据。

尚未覆盖：独立保留集、源真实性认证、未声明的语义/跨语言关系、原生 PG 公共质量、workspace 端到端、长时并发/断电、并发/时间快照、发布平台矩阵和性能 SLO。事实引用核实不是跨记录写入 CAS；变化后需显式更新声明。阶段 4 的 Context 消费重排/Answer 未开始。未改 Adapter/Capture/Injection/Agent 配置，未 commit/push。
