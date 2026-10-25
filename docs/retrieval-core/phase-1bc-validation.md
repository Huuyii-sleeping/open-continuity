# 阶段 1B/1C 长任务补验（2026-10-13）

本页是最新执行记录，不覆盖 [首轮历史验收](./phase-1-validation.md)。实现解释分开看：[1B 写入/恢复](./phase-1b-writes.md)、[1C 分页/权限](./phase-1c-pagination.md)。未提交、未 push，不自动进入阶段 2。

## 来源与执行范围

工作分支 `codex/core-v2`，HEAD 仍为 `e23207aa9e746c71a599af8e2a0c913c5d59bf94` 加未提交改动。前次阶段 1 源码 hash `609ef66a461ff59f4157b9d9b3284990d30d0c425dd372d5e6979a7171d45938`；本次最终源码 hash `46071049a98ad8ec4e1494df8a5f88bf919333c90ae400ce4b0f067c123b3eb0`。

质量数据 hash `97f0018b83f8043bc9ec7986df1537dacc46c52801e8249fe0e4244ad7139152`、评测器 hash `9a0d9244eca7f3e47604cb29ee34c7db72896f1aa5ac3e514eed3a4359a2d544`、锁文件与 Node v24.20.0 保持相同。没有修改标注、threshold、Required/Challenge 或默认检索排名。只使用虚构夹具和临时数据库，没有读取默认用户数据库/Agent 历史。

原始生成物位于本次独立临时 evidence 目录，不进入 Git。`storage-accepted.json`、`full-accepted.json`、`full-default.json`、`storage-default-final.json` 是工程结果；`postgres-round-1/2/3.json` 是三次新建原生实例；`suite.json`、`quality.json` 是旧正式评测；`final/` 与 `fresh-reference/`、`fresh-current/` 保留不同批次的逐题质量和全部容量样本。目录由运行者提供，不能作为长期已归档的 CI 证据。

## 1B：存储正确性与故障

| 路径 | 共享契约 | 本次证据 |
| --- | --- | --- |
| InMemory | 18/18 | 对象副本、ledger 重建、幂等/CAS/过滤/分页 |
| JSON | 18/18 | 重开 ledger、幂等回执与失败发布；仍是兼容路径 |
| SQLite | 18/18 | 真实 SQLite，事务/FTS/迁移回滚；null/Forget 回执修复 |
| PostgreSQL-pg-mem | 17/18，1 skipped | 保留 JSON 键是模拟器限制，不能记为通过 |
| 原生 PostgreSQL | 18/18 + 8 专项 | 真实事务/锁/DDL/JSON/幂等；26/26，三次新实例均通过 |

新增的真实缺陷证据有两类：Remember/Forget 回滚失败会透出驱动正文并复用不确定连接（2 个红测试）；SQLite 的 null Remember 错认 Forget 回执（1 个红测试）。修复后转绿。失败用例数量不是生产事故数量。

原生专项覆盖并发 merge 版本/审计链、同请求重试与 CAS-create 竞争、事件失败回滚、遗忘删除失败回滚、DDL 与迁移标记回滚、future schema 拒绝、成功 COMMIT 丢失回执、失败 ROLLBACK 后丢弃连接及恢复。COMMIT 回执丢失是驱动边界模拟，不冒充实际网络断线。

原生环境：官方 PostgreSQL 17.11、arm64，镜像 digest `sha256:b0f9560a2de083e2cc7382e75f808c7381a32852a7ec49117deedb300e552b24`。仅 loopback 临时端口、tmpfs、虚构测试用户/数据库与独立 schema；未安装全局 PostgreSQL。仅停止本任务实例，未清理用户缓存镜像或其他容器。

## 1C：分页与资格

每种路径独立覆盖静态分页无重复/遗漏、等时间 id tie-break、改变 limit、身份/过滤条件/入口绑定、legacy 重启、畸形/超长 cursor、构造匹配指纹后资格过滤仍有效。没有增加权限；Recall 的未确认策略与 Context 的确认策略保持原样。Workspace、并发 snapshot 与跨建库随机 UUID 全序不由这些测试证明。

## 召回质量（不与 Context 合分）

固定 `core-baseline-v1` 四种存储、三轮，对前次阶段 1 逐题比较：退化 0，变化排名指标 0。Recall@1/3/5、MRR、nDCG、miss/false selection 与原结果相同。

SQLite Recall Required 27/27，Challenge 6/33；全正例 Recall@3 61.76%、MRR@3 58.82%；miss 21/60，false selection 6/45。没有声明相关性提升；挑战仍保留。

## Context 选择（独立）

四种存储逐题选择与前次结果相同。SQLite Required 30/30，Challenge 6/30；全正例 Recall@3/MRR@3 均 52.94%；miss 24/54，false injection 6/36。不能用 Required 全通过掩盖 Challenge 的误选。

## 安全与稳定性（独立）

每存储、每入口的 user/agent/task/private 泄露均为 0/3；Context userConfirmed 为 0/6。Recall userConfirmed 为 0/0，按原策略未覆盖，不能写成确认门禁通过。各入口同库重复 60/60、重建 20/20 相同；当前事实选择 6/9，没有改善旧事实排序挑战。质量 PostgreSQL 指标仍来自 pg-mem，不能改名成原生结果。

## 容量性能（独立）

三轮/容量，SQLite 1k/10k，每操作 10 次预热后 200 个样本，P50/P95/P99 与原始样本全部保留，响应错误均为 0。

历史阶段 1 的 10k Exact/FTS/Context P95 范围为 1.616–1.626 / 3.273–3.551 / 3.291–3.326 ms。本次第一批最终源码测量为 1.677–3.171 / 3.486–4.244 / 3.429–3.783 ms，明显慢样本保留，不能宣称性能门禁通过或提速。

因此再串行运行同一 harness 的干净 e23207aa 与当前源码，两者同机/Node/锁文件、相同数据与轮次；没有执行中的测试容器。没有新增性能 SLO，也不能以返回结果正确替代耗时门禁。复测结果另列于下方。

`benchmark:lite` 的本次单轮 10k Exact/FTS/Context P95 为 1.682 / 3.153 / 3.256 ms（前次 1.628 / 2.967 / 3.009 ms）；它不是上述容量 workload，也不代表统计显著性。

最新串行复测：干净旧源码 hash `f9cdac371022806f090714c52658983fe2074e55bfa5267e1131d78e60d54fe7` 与当前最终源码；同口径质量比较仍为退化 0、变化排名指标 0。三轮 P95 范围 ms：

| 容量 | 操作 | 干净旧源码 | 当前源码 | 错误响应 |
| --- | --- | --- | --- | --- |
| 1k | Exact | 0.137–0.145 | 0.138–0.153 | 0 / 0 |
| 1k | FTS | 0.361–0.379 | 0.360–0.411 | 0 / 0 |
| 1k | Context | 0.370–0.394 | 0.360–0.565 | 0 / 0 |
| 10k | Exact | 1.681–1.746 | 1.668–1.685 | 0 / 0 |
| 10k | FTS | 3.599–4.219 | 3.337–3.435 | 0 / 0 |
| 10k | Context | 3.579–4.098 | 3.336–3.754 | 0 / 0 |

复测没有稳定重现第一批 10k Exact 的高尾延迟；旧源码也有慢轮次。该观测支持环境/测量波动的可能性，不能归因为已证明的原因；也不能据此宣称提速或严格无性能回归。所有慢样本继续保留，未选择性删除轮次；1k Context 的新高尾值同样明示。性能 SLO 仍未建立。

## 工程命令（独立）

- `npm run typecheck`、build、fixture 脚本语法检查通过。
- `npm test`：默认 230 passed / 27 skipped；显式原生 PG 时 256 passed / 1 skipped，39 文件通过。默认跳过的 26 项 PG 已在独立原生入口执行；剩余 1 项为 pg-mem JSON 键限制，原生对应断言通过。
- `npm run test:storage`：显式 PG 120 passed / 1 skipped；默认 94 passed / 27 skipped，默认 PG skipped 的结果单独保留，不算执行通过。
- `npm run test:storage:postgres:docker`：三次新实例各 26/26。额外用不存在的 reporter 令 Vitest 启动失败，入口保持非零退出并完成本实例清理，未吞掉失败。
- `npm run eval:suite`：185/185，泄露 0/40；与工程测试并行，耗时不作容量归因。
- `npm run eval:quality`：Required 15/15，Challenge 8/42，miss 22/36；旧 evaluator 的时间/UUID 波动与 false-injection 盲区仍在，不将相对首轮 7/42 的波动称为检索收益。
- `npm run eval:baseline`：质量/安全/稳定性与同口径比较通过；容量只确认响应有效，未建立 latency gate。
- `npm run benchmark:lite` 完成；`git diff --check` 无错误。

## 结论和限制

1B/1C 的本地实现与存储正确性补验完成。Team 仍为 preview：尚缺原生质量评测、长期服务/高并发、服务器重启/断电、跨平台/PG 版本矩阵和发布 CI。JSON 断电/stale lock、并发 snapshot 分页、性能 SLO 仍不是已实现能力；性能波动不作收益宣传。

Adapter/Capture/Injection/Agent CLI 配置未改，保留分支上此前阶段 0/1 的未提交内容。README、架构、benchmark、compatibility、CHANGELOG 已同步本次范围。进入阶段 2 仍须人工确认。
