# 7A：模块化独立验收

本文为初次7A历史验收；模块内部线路与分项测试的最新证据见 [后续补全](./phase-7a-module-routes-validation.md)。

2026-10-27，macOS / arm64 / Node 24.20.0 / npm 11.19.0。结论：本轮模块拆分、兼容、工程与本机性能回归门禁通过；原质量保持，语义能力没有提升。设计见 [7A](./phase-7a-modular-kernel.md)。没有 commit、push、PR 或远端 CI。

## 1. 对照来源

Before 是本轮开始时的完整工作区源码快照：HEAD `91aa7d3aa090720158e6d1bcac817a3d9888a961`，包含原有阶段6未提交内容及人工别名撤销。它不是纯 HEAD，也不是另一工作区的未提交内容。After 是本轮模块化实现，使用同一锁文件、当前评测器、虚构数据、标注和阈值。

| 指纹 | SHA-256 |
| --- | --- |
| Before `src/` | `56ae1643181c8108605f260a02b087f9437eca7858e65aaed70d771b1a613f7b` |
| After `src/` | `ed5938c3d2be6dbde7430f77e7056cded449a3bad35bb660a5d8e5838d23f4dc` |
| 共同 lock | `f5ae2716a582e6c6e7258137f5f823f8cc826fca708664e17a9844fa0fdd5102` |

源码、patch、逐次日志和原始报告保留在仓库外的本轮验收目录。以下为可公开的结果摘要；生成物、数据库、截图、真实历史、个人路径或配置不加入仓库。

## 2. 工程与兼容

| 验证 | 结果 | 证明范围 |
| --- | --- | --- |
| `npm run typecheck` | 通过 | 包含依赖检查脚本与新测试 |
| `npm run check:architecture` | 102 sources、376 edges、0 违规 | Core/Storage 与兼容入口依赖规则 |
| 受影响测试 | 437 通过、59 跳过 | Core、存储、可靠性、HTTP/MCP；后续新增2项也进入全套 |
| `npm test` | 533 通过、59 跳过，62 个文件通过 | 构建、全部工程回归；相对本轮前新增15项测试 |
| 原生 PostgreSQL fixture | PostgreSQL 17.11，58/58 | loopback / tmpfs 虚构数据库，完成后移除 |
| 两组 soak | 可靠性1项、Capture2项均通过，配置1000 cycles | 原进程/恢复和 Capture 重复链路 |
| 新旧入口 | 27 个非命令模块、83 个原运行时 export 保留 | 同名导出及值类型；主要构造函数另测对象身份 |
| 跨快照游标 | 2个策略×2个查询，6次续页通过 | 同一虚构SQLite、默认/拼写ON、新旧双向续页、无重复、跨身份拒绝 |
| 安装包 smoke | 通过 | 实际 tarball 安装；新旧类身份、独立Reader、BM25、迁移命令文件、原demo/setup/治理 |
| production dependency audit | 0 vulnerabilities | `npm audit --omit=dev`，不是来源或秘密扫描证明 |
| `git diff --check` | 通过 | 文本差异检查 |

全套中的58个原生PG条件跳过已由独立fixture实际执行；剩下1项是既有pg-mem JSON key限制。不能把pg-mem结果替代原生PG，也不据本机结果宣称远端矩阵通过。安装包的客户端为虚构进程，没有新增真实Agent客户端验证。

Reader新增测试覆盖选中通道调度、错误通道、部分注册/缺失提前拒绝、请求参数隔离、legacy wrapper观察、四条存储路径等价、Context/Query在top-K前资格过滤，以及超时后未结束读仍占容量。架构反例检查实际抓到存储命令调用application工厂的越层，命令已移至 `cli/storage`。

跨快照响应比较只排除每次自然变化的 `factAssessment.evaluatedAt`，仍校验时间格式；其它响应字段、排名、分数、事实结果与cursor均比较。命令模块具有副作用，导出比较有意排除它们，不运行默认数据库迁移。

安装包首轮新增虚构样例漏填必需的幂等键，被原校验拒绝；补齐样例后重新完整打包安装通过。失败日志保留，生产校验没有放宽。

## 3. 原质量与Challenge

`eval:suite` 五轮185/185，安全泄露0/40。`eval:quality` 三轮 Required15/15、Challenge9/42，安全0/6、false injection0/6、miss21/36。与本轮前结果相同；这些重复观测不等于相同数量的独立问题，也不证明真实用户效果。

同评测器公共基线：20个独立问题、4存储×2入口×3重建轮次，共480条记录；各组去除延迟后的全部质量/安全/稳定性统计前后完全相同，回归比较通过。下面的数值 **Before = After**：

| 存储 / 入口 | Recall@5 | MRR@5 | miss rate | false selection / injection |
| --- | --- | --- | --- | --- |
| SQLite / Recall | 0.6765 | 0.6471 | 0.3000 | 0.1250 |
| SQLite / Context | 0.5882 | 0.5882 | 0.3889 | 0.1538 |
| InMemory / Recall | 0.6176 | 0.5882 | 0.3500 | 0.1333 |
| InMemory / Context | 0.5294 | 0.5294 | 0.4444 | 0.1667 |
| JSON / Recall | 0.6176 | 0.5882 | 0.3500 | 0.1333 |
| JSON / Context | 0.5294 | 0.5294 | 0.4444 | 0.1667 |
| PostgreSQL pg-mem / Recall | 0.6176 | 0.5882 | 0.3500 | 0.1333 |
| PostgreSQL pg-mem / Context | 0.5294 | 0.5294 | 0.4444 | 0.1667 |

该表包含Challenge，因此误选并不为0；它与quality-v1安全负例的false injection使用不同样例和分母。Recall@1/3、nDCG、逐题顺序和所有轮次保留在拆分报告中，不能将此表当作新的综合总分。

## 4. 安全、稳定性与事实选择

公共基线每存储/入口的user、agent、task、private暴露为0/3；Context确认边界为0/6。Recall默认允许未确认记忆，其确认分母为0，属于未测量，不写作“零确认泄露”。Workspace由既有Adapter/Injection实施，本内核基线没有独立覆盖；原工程/评测回归通过不等于新增workspace认证能力。

每存储/入口同库重复稳定60/60、重新建库稳定20/20，前后保持。重建夹具有相对写入时间顺序，不能宣称相同时间戳+随机UUID跨库完全稳定。当前/旧事实选择6/9（3个独立问题的重复观测），前后保持；未声明的语义事实冲突仍是Challenge。

逐层诊断：38个虚构独立问题，4存储×3入口×3重建轮次=1368条记录，每条3次技术响应；前后比较无退化。实际通道、诊断重放、候选/排名/Context/Query/事实归因继续分别保存；已暴露固定验收集不是盲测。零回归不意味着每题已经正确。

## 5. 性能独立对照

`benchmark:lite`，每次新建10k虚构记忆，100次请求；三个配对轮次串行执行，顺序为Before→After、After→Before、Before→After。下面保留全部六轮的P95，单位ms：

| 轮次 / 版本 | exact-key Recall | FTS Recall | Context |
| --- | --- | --- | --- |
| 1 / Before | 1.956 | 3.755 | 3.570 |
| 1 / After | 1.915 | 3.458 | 5.397 |
| 2 / Before | 5.132 | 5.613 | 6.004 |
| 2 / After | 2.137 | 4.073 | 3.682 |
| 3 / Before | 2.755 | 3.837 | 3.935 |
| 3 / After | 2.060 | 3.498 | 3.557 |

三轮P95中位数：exact 2.755→2.060；FTS 3.837→3.498；Context 3.935→3.682。均满足测量前声明的回归预算 `After ≤ Before × 1.25 + 1ms`。写入吞吐中位数1872.075→1833.009次/秒。原P50/max、seed耗时和数据库大小保留在各轮报告中；After的FTS三轮max中位数13.858ms，高于Before的9.705ms，慢样本没有删除。

这些是本机描述数据，没有隔离所有系统噪声，也没有新增算法消融，不能把较低P95归因于“模块化带来稳定提速”，更不是生产SLO。

## 6. 可选拼写策略单独验收

`eval:lexical` 工程完整性通过；默认启用接受仍失败，保持OFF。合法词负例的6个入口/题目退化原样保留；10k broad-probe三轮P95中位数ON3.0311ms，对应门槛2.4427ms，成本失败保留。原题OFF/ON无新增退化。这组结果不影响默认重构验收，也不能被其它通过项覆盖。

## 7. 复现与剩余工作

所有命令只使用显式虚构夹具或临时数据库；报告目录必须是新的目录。先保存本轮Before完整源码，再在当前工作区运行：

```bash
npm run check:architecture
npm run typecheck
npm test
npm run eval:suite
npm run eval:quality
npm run eval:baseline -- --source=<before-source> --report-dir=<baseline-before>
npm run eval:baseline -- --report-dir=<baseline-after> --compare=<baseline-before>/raw-report.json
npm run eval:diagnostics -- --source=<before-source> --report-dir=<diagnostics-before>
npm run eval:diagnostics -- --report-dir=<diagnostics-after> --compare=<diagnostics-before>/raw-report.json
npm run eval:lexical -- --report-dir=<lexical-report>
npm run benchmark:lite -- --memories=10000 --iterations=100
npm run test:storage:postgres:docker
npm run test:reliability:soak
npm run test:soak
npm run smoke:package
npm audit --omit=dev --registry https://registry.npmjs.org
npm pack --dry-run
```

Benchmark命令分别在Before/After工作目录执行三组配对。`release:check`聚合命令未重复执行，其typecheck/test/suite/quality/audit/pack/package组成项已独立运行；未触发远端CI或发布。

源码范围核对：既有Adapter/Capture/Injection与各Agent CLI文件内容完全不变；新增CLI仅3个通用storage命令。SQLite/PG schema去除import路径后完全相同，锁文件和数据集字节不变。原阶段6工作区改动保留，staging仍为空。

剩余限制：旧入口为兼容继续保留；依赖检查覆盖字面引用，不是任意运行时依赖证明；PG仍是substring fallback/preview，JSON仅兼容；SQL硬取消、生产身份认证与SLO未新增。后续Embedding需要独立设计provider、版本化派生索引、写入/更新/遗忘/恢复/重建同步及质量/成本/授权边界，本轮未接入。
