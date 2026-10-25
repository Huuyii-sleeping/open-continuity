# 阶段 1 独立验收（2026-10-13）

本页保留首轮历史证据，未运行项描述的是该次执行。后续 1B/1C 长任务的原生 PostgreSQL、故障修复与新增断言见 [补验记录](./phase-1bc-validation.md)，不要将不同 suite 的通过数直接作缺陷数量比较。

## 来源

干净旧源码：e23207aa，源码 hash `f9cdac371022806f090714c52658983fe2074e55bfa5267e1131d78e60d54fe7`。阶段 1 源码 hash `609ef66a461ff59f4157b9d9b3284990d30d0c425dd372d5e6979a7171d45938`。同一 HEAD 加未提交源码，不将行为归属为干净 commit。

同一评测器 hash `9a0d9244eca7f3e47604cb29ee34c7db72896f1aa5ac3e514eed3a4359a2d544`，同一数据集 hash `97f0018b83f8043bc9ec7986df1537dacc46c52801e8249fe0e4244ad7139152`。Node、锁文件、K、预算与轮次相同。测试层为标准 strpos 添加透明 pg-mem 模型后，重新运行干净 reference；未复用不同 evaluator hash 的昨日报告。

## 存储正确性

同一共享 suite 在旧源码上 34 passed / 21 failed / 1 未验证；当前 55 passed / 0 failed / 1 未验证。新增契约缺失和实际缺陷分别解释，21 项不是 21 个生产故障。

| 存储 | 当前共享契约 | 说明 |
| --- | --- | --- |
| InMemory | 14/14 | 进程内语义 |
| JSON | 14/14 | 兼容 ledger |
| SQLite | 14/14 | 真实本地 SQLite |
| PostgreSQL-pg-mem | 13/14，1 未验证 | 模拟器保留 JSON 键会丢失，不判通过 |
| 真 PostgreSQL | 17 项未运行 | 原生套件保留，环境未提供 |

实际重现/修复包括分隔字符串键碰撞、返回对象别名、忘记事件幂等键、跨过滤器游标、PG 通配符扩大命中、循环/稀疏 JSON 的存储差异。SQLite 5 项事务/迁移/导入故障测试通过；JSON 2 项失败发布/无效 ledger 通过；PG 2 项 driver 顺序与初始化恢复通过，后者不证明真实锁/rollback。

## 召回质量

四存储逐题、K=1/3/5 的 Recall、MRR、nDCG 和误选/事实版本指标与 reference 相同。回归比较 passed；退化信号 0，变化排名指标 0。没有相关性收益声明。

SQLite Recall Required 27/27；Challenge 6/33。全正例 Recall@3 / MRR@3 为 61.76% / 58.82%。Required/Challenge 及其它存储仍在各自独立报告中展示，不取跨存储平均。

## Context 选择

四存储逐题选择指标与 reference 相同。SQLite Context Required 30/30；Challenge 6/30，全正例 Recall@3 / MRR@3 为 52.94% / 52.94%。旧事实仍可排在当前事实前，改写/跨语言/排序挑战不被存储阶段抹掉。

## 权限安全

每种存储、每个入口独立检查：user/agent/task/private 各有 3 个禁止夹具暴露；Context userConfirmed 有 6 个，均无泄露。Recall userConfirmed 分母为 0，按既有政策不强制确认，不记为通过。Workspace 和真实 PG 不在本内核报告覆盖范围。

## 排序稳定性

各存储、各入口同库重复 60/60 相同，重新建库 20/20 相同。共享存储测试另外覆盖同时间戳/id tie-break 的静态分页无重复/遗漏。跨建库随机 UUID 的全序一致及并发快照分页不因此得到证明。

## 容量性能

SQLite 1k/10k，各自三轮；每操作预热 10 次后测 200 次。P50/P95/P99 与原始样本保留，以下仅列三轮 P95 范围 ms。结果为本机描述，不是性能 SLO 或统计显著性结论。

| 容量 | 操作 | reference P95 ms | 阶段 1 P95 ms | 响应校验 |
| --- | --- | --- | --- | --- |
| 1000 | exact | 0.127–0.143 | 0.131–0.145 | 0 错误 / 0 错误 |
| 1000 | fts | 0.348–0.364 | 0.365–0.376 | 0 错误 / 0 错误 |
| 1000 | context | 0.349–0.355 | 0.340–0.432 | 0 错误 / 0 错误 |
| 10000 | exact | 1.620–1.649 | 1.616–1.626 | 0 错误 / 0 错误 |
| 10000 | fts | 3.258–3.276 | 3.273–3.551 | 0 错误 / 0 错误 |
| 10000 | context | 3.314–3.617 | 3.291–3.326 | 0 错误 / 0 错误 |

没有用漏掉/无关结果换速度，也没有宣称提速。存储保留完整事务、请求快照与 JSON 校验，分页增加条件指纹。

## 工程与旧套件

- Typecheck、build 通过；npm test：38 文件通过、1 未运行，211 passed、18 未验证。
- test:storage：75 passed、18 未验证（17 真 PG + 1 模拟 JSON 键）。
- eval:suite：185/185，泄露 0/40；与其它工程测试并行，其耗时不用于容量归因。
- eval:quality：Required 15/15，Challenge 7/42；旧 evaluator 的时间/UUID tie 与 false-injection 口径限制仍在，不把昨日波动算成质量提升。
- benchmark:lite：10k 完成，Exact/FTS/Context P95 1.628 / 2.967 / 3.009 ms；旧 workload 的本次单轮结果，独立于三轮容量证据。

## 兼容与未验证

普通 Recall/History 的旧游标需从第一页重启；v2 绑定身份/权限/过滤器。query Retrieval 游标未改。PG %/_ 按字面量处理，capability 为 postgres_substring。SQL schema 版本未增加，较新 schema 拒绝访问，包括关闭自动迁移的情况。

真实 PG 锁/回滚/保留 JSON 键、远端矩阵、JSON 掉电/陈旧锁恢复及并发快照分页未验证。已提供显式 loopback 隔离 PG 测试入口，没有伪称运行。

此前 Spike 19 个文件的外部副本已校验，其重建源码 hash 与昨日一致，内容可恢复。Adapter、Capture、Injection 和 Agent CLI 配置未改，没有 commit/push，不自动进入阶段 2。
