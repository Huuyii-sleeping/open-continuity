# 7A内部线路补全：独立验收

本文保留该次交付的历史结果；后续策略/Runtime/职责登记和报告漏验修正见 [线路收尾验收](./phase-7a-route-completion-validation.md)。

2026-10-27，macOS arm64 / Node24.20.0。以初次7A交付工作区为Before，继续拆分内部线路与分项测试。本次工程、兼容、原质量和本机成本回归门禁通过；旧7A报告保留历史证据。所有数据为虚构夹具，未读取默认数据库或真实Agent历史；未commit/push/远端CI，Embedding未接入。

## 对照与工程

Before `src/`指纹：`ed5938c3d2be6dbde7430f77e7056cded449a3bad35bb660a5d8e5838d23f4dc`。
After `src/`指纹：`534a04187272baea4f105e7e3f856d89fe28b05e445370211c4786d36b17fa95`。
同一lock/评测器/数据集/标注/阈值，Before包含原阶段6及初次7A工作区实现，不是纯HEAD。

- typecheck和依赖门禁通过，169个源码、655条引用、0越层。
- 最终全套：583项通过、59项条件跳过，100个文件通过。
- 相对初次7A新增50项测试；分项命令包含17个测试分组、76条线路，491项通过、59跳过、0失败。其范围是Core、存储、可靠性、HTTP/MCP及工厂；完整`npm test`还包含其它既有入口/Adapter测试，因此计数不同。
- 单线路`query/history`独立运行，2/2通过；其余线路按各自测试文件单独报告。部分skip的组显示partial，PG条件文件显示skipped，不被写成passed。
- PostgreSQL17.11虚构loopback/tmpfs夹具58/58，通过后移除；覆盖全套中的58项原生PG条件跳过。剩下1项是既有pg-mem JSON key限制。
- reliability与Capture两组1000-cycle soak通过，实际tarball安装后的旧/新入口、Reader、BM25、通用storage命令、文档、demo与虚构客户端setup/治理smoke通过；不是新增真实Agent客户端验证。
- `git diff --check`通过；独立测试/原始报告保留仓库外，不进入提交。没有把适配层测试成绩当作某条Core线路的单元证据。

新增独立测试覆盖：Query参数/历史总预算/证据版本/事实超时清理/空Context拒答；覆盖与排名装包共用预算、UTF-8分隔符计费、未核实声明拒绝；替代引用的精确版本、私有/截断事实组；原值和引用篡改；写入幂等冲突先于投影更新、PG失败rollback销毁session；列表/排名游标与访问授权。报告器拒绝未知/空选择、零断言、缺失/意外文件与重复結果，并核对执行前后指纹。

## 原质量

`eval:suite`185/185，安全0/40。`quality-v1` Required15/15、Challenge9/42、安全0/6、false injection0/6、miss21/36，前后相同；重复观测不等于独立问题数。

公共基线480条记录的全部非延迟统计前后相同；逐层诊断1368条记录比较通过。SQLite Recall@5 0.6765、MRR@5 0.6471、miss0.3000，Context Recall@5/MRR@5均0.5882；这些含Challenge，不能理解为每题正确。其它存储/入口、各K、分母、误选、稳定性、事实选择在拆分原报告保留。

SQLite基线Recall false selection6/48、Context false injection6/39，包含Challenge，与quality-v1的负例分母不同。各存储/入口重复稳定60/60、重建稳定20/20、当前事实选择6/9，均保持；相同时间戳/随机UUID跨库稳定不在该基线覆盖中。

基线每存储/入口user/agent/task/private为0/3暴露；Context确认边界0/6。Recall允许未确认记忆，其确认分母为0，不能记作“零确认泄露”。Workspace由既有Adapter/Injection实施，不新增认证声明。

可选拼写消融工程有效，默认开启接受仍失败：合法词负例保留6个题目/入口退化；10k broad-probe ON三轮P95中位数3.3161ms，门槛2.4743ms，成本失败保留。默认OFF，不用模块化通过掩盖这些失败。

## 成本与兼容

每次新建10k虚构记忆、100请求；在工程/质量工作全部结束后重新串行运行三个配对，顺序Before→After、After→Before、Before→After。预设P95中位数预算仍为`After≤Before×1.25+1ms`，没有因结果调整门槛。各轮P95（ms）：

| 轮次/版本 | exact-key Recall | FTS Recall | Context |
| --- | --- | --- | --- |
| 1 Before | 1.837 | 3.440 | 3.367 |
| 1 After | 1.739 | 3.340 | 3.381 |
| 2 Before | 1.770 | 3.299 | 3.267 |
| 2 After | 1.803 | 3.478 | 3.332 |
| 3 Before | 1.912 | 3.469 | 3.364 |
| 3 After | 1.747 | 3.231 | 3.350 |

P95中位数：exact1.837→1.747，FTS3.440→3.340，Context3.364→3.350，三个预算均通过。写入吞吐中位数2134.347→2097.164次/秒。完整P50/max/seed/数据库大小保留在每轮原报告，没有删慢样本。这是本机回归证据，不归因于稳定提速，也不是生产SLO。

初轮性能与后续最终测试曾有部分重叠，该组原始日志保留为运行记录，未用于最终成本门禁。最终表来自完整重新执行的六轮，不从原轮次选择性挑快样本。

跨快照默认/拼写ON、2个查询、6次双向续页通过；27个非命令兼容入口84个运行时export保留。主要构造身份与已有契约测试通过。权限、默认指纹、排序、schema保持，Embedding未接入。

## 复现和边界

```bash
npm run typecheck
npm run check:architecture
npm run test:core:list
npm run test:core -- --module=query --route=history
npm run test:core -- --report-dir=<仓库外新目录>
npm test
npm run eval:suite
npm run eval:quality
npm run eval:baseline -- --source=<before-source> --report-dir=<before-report>
npm run eval:baseline -- --report-dir=<after-report> --compare=<before-report>/raw-report.json
npm run eval:diagnostics -- --source=<before-source> --report-dir=<before-diagnostics>
npm run eval:diagnostics -- --report-dir=<after-diagnostics> --compare=<before-diagnostics>/raw-report.json
npm run eval:lexical -- --report-dir=<lexical-report>
npm run benchmark:lite -- --memories=10000 --iterations=100
npm run test:storage:postgres:docker
npm run test:reliability:soak
npm run test:soak
npm run smoke:package
```

Benchmark分别在Before/After目录串行执行三组。`release:check`聚合命令没有重复运行，工程、质量、soak和包组成项已独立执行；未发布或触发远端CI。

源码范围核对：Adapter/Capture/Injection/各Agent CLI字节未变；SQLite/PG schema与lock/data集字节不变，最终源码匹配评测指纹。原工作区修改保留，staging为空。

必要共享状态和编排仍存在：事务不能拆成独立提交，Context不能拆成多套预算，Query须按计划调度。独立测试定位观测失败线路，不能保证自动判断根因。PG依旧substring fallback/preview，JSON仅兼容，合作式超时不硬取消SQL；模型/向量索引、生产身份认证和SLO未新增。
