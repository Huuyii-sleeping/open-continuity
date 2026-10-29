# 7A线路收尾：验收

本轮以此前7A内部线路交付工作区为Before。完成选择策略/Runtime叶子/窄packer/职责登记与报告漏验修正后，使用同依赖、同数据集、同评测器对照。工程、原质量、兼容、性能分别记录，未执行项不声明通过。

2026-10-27，macOS arm64 / Node24.20.0 / npm11.19.0。最终工程：618项通过、59项条件跳过，126个测试文件通过；typecheck/architecture通过。独立报告、原质量、兼容和本机成本结果分别记录。所有数据为虚构夹具；未读取真实Agent历史或默认数据库，未commit/push。

结论：本次边界与验收缺口补齐通过。原质量保持，性能在预设回归预算内，不能宣称语义提升或稳定提速。

## 工程与验收完整性

| 项目 | 本轮结果 | 边界 |
| --- | --- | --- |
| typecheck / architecture | 通过；180源码、685条引用、0越层 | 策略与Runtime叶子不能反向依赖所有者 |
| 完整测试 | 618通过、59跳过 | 比本轮前583增加35项，不是召回率提升 |
| 分模块报告 | 17分组、102线路、526通过、59跳过、0失败 | 包含Core/Storage/可靠性/HTTP/MCP/工厂，范围不同于完整测试 |
| 职责登记 | 55个主要职责映射到实现/测试 | 分unit/backend_contract/integration，不等于行/分支覆盖 |
| 单线路选择 | `context/selection-relevance`通过 | 可独立执行，不依赖全套报告 |
| 游标/旧导出 | 默认与拼写ON，6次双向续页；27非命令入口84原导出保留 | 同一虚构SQLite，除校验合法的自然评估时间外比较全部字段 |
| 原生PostgreSQL | 17.11，一次性loopback/tmpfs，58/58 | 清理已确认；全套中的58项条件跳过另行执行 |
| 两组soak/安装包 | 1000-cycle配置下均通过；tarball安装smoke通过 | 实际Reader/BM25/旧类身份/文档，客户端为虚构进程 |

新增测试覆盖选择资格/信号/三种顺序、observer失败隔离、Reader注册与legacy包装、Runtime配置、预算后充分性、降级原因；InMemory写入/遗忘/列表/历史/重放与SQLite/PG窄port独立验证。报告修正同组零断言漏验，重复选择、未知status和负耗时都不能形成合法结果。关键实现或测试缺失会在验收前拒绝。

`operations-read`旧选择名已独立运行，实际报告为`storage-postgres/history-port`，1/1通过。分项报告仍保留PG条件文件skipped、跨存储pg-mem限制partial；独立PG夹具通过不会静默改写原报告。除该模拟器限制外，未新增未验证的条件跳过。独立测试定位的是观察失败位置，不保证自动诊断根因。

## 原质量、安全、稳定与事实

`eval:suite`185/185，安全0/40。`quality-v1` Required15/15、Challenge9/42、安全0/6、false injection0/6、miss21/36。与本轮前相同，重复观测不是独立问题数。

同评测器公共基线480记录，各存储/入口去除延迟后的全部统计前后完全相同；逐层诊断1368记录比较通过。SQLite Recall@5=0.6765、MRR@5=0.6471、miss=0.3000；Context Recall@5/MRR@5=0.5882、miss=0.3889。其它存储/入口、各K/nDCG、分母与逐题结果保留在分报告中。重构无语义提升，不改变标注或Challenge。

基线SQLite Recall false selection6/48、Context false injection6/39含Challenge，和quality-v1安全负例分母不同。各存储/入口user/agent/task/private为0/3暴露，Context确认0/6；Recall默认允许未确认，确认分母为0，不能记作零泄露。Workspace不在该内核基线覆盖内，既有Adapter/Injection边界未改。

各存储/入口同库重复稳定60/60、重建稳定20/20、当前事实选择6/9，均保持；相同时间戳与随机UUID跨库稳定、真实语义冲突/真伪不因此得到证明。

可选拼写策略另验：工程完整性通过，默认启用接受仍失败，保留6个合法词题目/入口退化。10k broad-probe ON三轮P95中位数2.7797ms，对应门槛2.3383ms，成本失败保留。默认OFF，不用重构通过覆盖该机制失败。

## 来源

Before是本轮开始的工作区快照，包含此前阶段6与7A未提交内容，不是纯HEAD，也不来自另一个workspace。Before `src/` SHA-256：`534a04187272baea4f105e7e3f856d89fe28b05e445370211c4786d36b17fa95`；After：`b3f5d3392e0c44beaa3fa5f202659bf7a3a63c5531be01ee37c9cfa28aecb49e`。使用同一lock、当前评测器、原数据集和阈值。

最终源匹配评测指纹；Adapter/Capture/Injection/各Agent CLI字节不变；SQLite/PG schema、lock、数据集字节不变，staging为空。源快照、失败反例、逐次日志、分项JSON和性能报告保留仓库外，不入提交。

## 本机性能与复现

全部工程/质量/PG/soak/package工作结束后，串行执行三组10k虚构记忆、100请求的前后配对，顺序Before→After、After→Before、Before→After；不并行跑其它测试。沿用测量前预设预算`After P95中位数≤Before×1.25+1ms`。六轮P95（ms）：

| 轮次/版本 | exact-key Recall | FTS Recall | Context |
| --- | --- | --- | --- |
| 1 Before | 1.720 | 3.208 | 3.182 |
| 1 After | 1.712 | 3.267 | 3.210 |
| 2 Before | 1.788 | 3.236 | 3.307 |
| 2 After | 1.903 | 3.899 | 3.775 |
| 3 Before | 1.763 | 3.481 | 3.732 |
| 3 After | 1.955 | 3.374 | 3.560 |

P95中位数：exact1.763→1.903（+7.9%）、FTS3.236→3.374（+4.3%）、Context3.307→3.560（+7.7%），均在预设预算内。吞吐中位数2099.283→2120.450次/秒。较慢轮次、P50/max/seed与数据库大小都保留；本机噪声和小幅成本变化不能据此认定稳定性能收益，也不构成生产SLO。

```bash
npm run typecheck
npm run check:architecture
npm test
npm run test:core -- --report-dir=<仓库外新目录>
npm run test:core -- --module=context --route=selection-relevance
npm run eval:suite
npm run eval:quality
npm run eval:baseline -- --source=<before-source> --report-dir=<baseline-before>
npm run eval:baseline -- --report-dir=<baseline-after> --compare=<baseline-before>/raw-report.json
npm run eval:diagnostics -- --source=<before-source> --report-dir=<diagnostics-before>
npm run eval:diagnostics -- --report-dir=<diagnostics-after> --compare=<diagnostics-before>/raw-report.json
npm run eval:lexical -- --report-dir=<lexical-report>
npm run test:storage:postgres:docker
npm run test:reliability:soak
npm run test:soak
npm run smoke:package
npm run benchmark:lite -- --memories=10000 --iterations=100
```

Benchmark分别在Before/After目录执行三组配对。未重新执行`release:check`聚合命令，工程/质量/soak/包步骤已独立执行；未发布/远端CI。本轮没有新增真实Agent客户端或企业身份认证验证。

必要的事务、请求scope/容量和预算所有者保留，不把它们拆成各自提交或重复计费。职责登记覆盖主要责任，不穷举辅助函数或所有分支；依赖门禁覆盖字面引用，不能证明任意运行时零耦合。PG继续substring fallback/preview，JSON继续兼容；Embedding/向量索引、语义裁决和SQL硬取消没有实现。
