# Embedding 实验接入验收

2026-10-28，本机 macOS ARM64 / Node 24.20.0。数据全部虚构；临时 SQLite 显式创建、结束后清理，没有读取真实 Agent 历史或默认数据库。模型权重、平台运行库、原始报告和容量脚本保存在仓库外，没有 commit/push。

结论：**工程接入可运行，默认语义质量门禁不通过。** 保守模式能补回部分字面检索遗漏，但两组语义池仍有否定误召回；直接 hybrid 会破坏原 Required 选择行为。默认 Exact / Structured / BM25 不变。

## 工程结果

| 验证 | 结果 |
| --- | --- |
| `npm run typecheck`、`npm run check:architecture` | 通过 |
| 受影响测试与新增接入测试 | 通过；新增 38 项，分 Core 17、SQLite 15、跨存储能力 4、MCP/HTTP 协议 2 |
| `npm test` | 702 passed，59 conditional skipped；跳过不是通过 |
| 分线路报告 | `retrieval/dense-integration` 与 `storage-sqlite/dense-index` 单独通过 |
| `npm run eval:suite` | 185/185；安全泄露 0/40；Injection P95 3.154ms |
| `npm run eval:quality`（默认 OFF） | Required 15/15；Challenge 9/42；总体 24/57；与原基线质量相同 |
| 原 quality-v1 安全/负例口径 | 泄露 0/6；false injection 0/6；正例漏召回 21/36 |
| `npm run benchmark:lite` | 10k；Exact P95 2.100ms，FTS 3.628ms，Context 3.815ms |

新增测试验证：可选 schema、不支持能力的明确拒绝、用户/Agent/Task/private/批准过滤先于比较、写入与任务事务一致、幂等、过时事件/版本拒绝、跨连接及同模型 epoch 重建、重新打开恢复、损坏/缺失/超出预算拒绝、流式事务异常释放、真实余弦/排名/RRF、Context/Query 引用、实验游标失效、模型错配/超时/容量与关闭 drain。

线路报告曾拒绝一组重复的参数测试名称：NaN 与 Infinity 在 JSON 名称中都变成 null。已改为不同场景名称，再次通过完整网格；没有降低报告检查规则。首次真实模型试跑也因运行配置指纹不匹配被拒绝，未计入质量成果；评测器现要求索引真实计算成功且完成，不能把模型未运行误当作“无误召回”。

PG 本轮只验证 pg-mem 能力/契约与原测试；没有执行新原生 PostgreSQL 环境、Windows/Linux 原生模型或真实 Agent Hook 测试，也没有宣称这些路径具有 Dense。

## 实际 Core 质量对照

使用固定多语言 MiniLM q8、384 维、masked mean + L2、CPU2、128 token 上限；权重和 tokenizer 沿用前期公开模型缓存。外置 ONNX 图和权重重新匹配已冻结 SHA-256；运行配置指纹为 `3cb383ef5694fd3c3799ffb8264b258d43c433003ebc2d3e8929857017696136`。配置指纹包含物理运行形式，不能与前期其它运行配置混用。

每个固定夹具分别运行 Recall、Context、Query，各重复三次。下表是 **Context** 分项；原始报告分别保留三个出口、实际通道/评分回执、每题结果、版本值核对及索引任务。重复轮次不增加独立样本数。两组语义池来自之前已观测的完全虚构回归题，不是独立盲测；quality-v1 的原标注和写入顺序未改。

| 数据与模式 | Recall@1 / @5、MRR | miss rate | 负例误召回 | 错选项 / 所有返回项 | 完整用例通过 |
| --- | --- | --- | --- | --- | --- |
| quality-v1 OFF | 41.7% | 7/12 | 0/2 | 2/7 | 7/14；Required 5/5 |
| quality-v1 miss_only | 41.7% | 7/12 | 0/2 | 2/7 | 7/14；Required 5/5 |
| quality-v1 hybrid | 75.0% | 3/12 | 2/2 | 7/16 | 6/14；Required 3/5 |
| 语义回归 A OFF | 0% | 11/11 | 0/7 | 0/0（不可判定） | 7/18 |
| 语义回归 A miss_only | 45.5% | 6/11 | 2/7 | 2/7 | 10/18 |
| 语义回归 A hybrid | 45.5% | 6/11 | 2/7 | 3/8 | 10/18 |
| 语义回归 B OFF | 0% | 12/12 | 0/12 | 0/0（不可判定） | 12/24 |
| 语义回归 B miss_only | 33.3% | 8/12 | 5/12 | 5/9 | 11/24 |
| 语义回归 B hybrid | 50.0% | 6/12 | 7/12 | 10/16 | 10/24 |

这里的“错选项”分母是返回项数量；原 quality-v1 `falseInjectionRate` 只统计指定无相关记忆负例，不能混为同一个比率。原质量集合安全泄露保持 0/2；语义回归池没有身份边界题，安全指标是无分母的不可判定，权限另由工程测试验证。

所有固定夹具的三轮输出顺序一致，56/56；改成流式扫描与真正归一化余弦后，三个模式、三个出口的所有已选标签与改造前完全相同。单候选或模糊竞争继续拒绝，因此保守模式没有补回 quality-v1 的一些单条语义题；没有为提高 Recall 取消比较/权限/批准要求。

即使 hybrid 的 Recall 上升，也不能宣布整体改善：quality-v1 完整通过率及 Required 回退，语义回归 B 的负例明显恶化。较重 NLI 本轮未接入实际质量对照；已有资源失败仍保留，不能用之前的单模型成绩替代本轮完整管道验证。

复现入口：

```bash
npm run eval:dense -- --provider=<显式本地 provider 模块> --output=<仓库外报告>
npm run test:core -- --module=retrieval --route=dense-integration --report-dir=<新目录>
npm run test:core -- --module=storage-sqlite --route=dense-index --report-dir=<新目录>
```

模型模块必须实现 [设计中的接口](./embedding-integration.md)，对实际文件/运行配置做完整性和指纹核对；命令不会自动安装、下载模型或使用默认长期库。质量失败在报告中保留，执行成功只说明评测完成，不表示所有 Challenge 已通过。

## 模型与完整管道成本

六次最终独立模型会话加载 0.347–0.495 秒，模型进程峰值 RSS 196.4–200.9MiB；网络尝试均为 0。子进程移除开发测试宿主的 tsx loader，避免把 TypeScript 运行开销误算到模型。峰值 RSS 不是物理独占内存，也不能代替整个服务驻留。

小回归池的最终 Context P95：OFF 0.16–0.35ms，miss_only 2.02–2.91ms，hybrid 2.50–2.51ms。语料只有 1–16 条/身份，不能外推为 10k 性能。

另做 **一轮机械容量对照**：每容量 5 次预热、50 个 OFF/ON 交错样本，包含 SQLite 授权读取、模型 IPC、余弦比较、RRF 和 Context。用相同虚构原值重复写入，复用该原值的真实模型向量；只验证容量成本，不表示 10k 不同文本的索引吞吐或召回质量。ON 是显式 hybrid。

| 容量 | 物化全部向量：ON P95 / 主进程峰值 | 流式扫描：ON P95 / 主进程峰值 | 同轮 OFF P95 |
| --- | --- | --- | --- |
| 1k | 38.67ms / 360.98MiB | 24.02ms / 205.91MiB | 0.52ms |
| 10k | 450.24ms / 1013.81MiB | 364.09ms / 330.22MiB | 2.59ms |

完整容量请求无错误；主进程统计含开发宿主、SQLite 和堆，不含另一个模型进程；不能只用模型约 200MiB 宣称整个工具占用约 200MiB。流式设计最多保留 100 个排名候选，不缓存全量 JS 向量；10k 主进程峰值下降约 67%，但仍是线性扫描，没有 ANN/向量扩展或生产 SLO 保证。

本轮关闭条件明确：继续默认 OFF。后续优先解决意图/否定误召回、单候选的可验证准入和向量搜索成本，再做独立盲测、用户模型安装恢复、跨平台与真实闭环验收；不通过改标注或降低门槛开启默认 Dense。
