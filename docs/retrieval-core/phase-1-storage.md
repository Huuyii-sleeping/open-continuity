# 阶段 1：可信存储内核

日期：2026-10-13。实现基于 `core-v2` 分叉点 `e23207aa` 与阶段 0 评测器。Adapter hardening 的上游提交没有合入本工作区。

最新长任务补验分开查看：[1B 写入/恢复](./phase-1b-writes.md)、[1C 分页/权限](./phase-1c-pagination.md)、[最新结果](./phase-1bc-validation.md)。下文首轮统计是历史快照，不覆盖为新的测试计数。

## 1A：职责与契约

`src/core/storage-contract.ts` 定义三个职责：

- `MemoryPersistence`：原子 remember/forget、版本、幂等、历史和资源关闭。
- `MemoryRepository`：增加 `list(StructuredMemoryInput)`，只接受身份、权限和结构化过滤，不接受 query；返回时间/id 排序的列表，不声称相关性。
- `LegacyMemoryLookup`：保留 `recall(ParsedRecallInput)`，兼容既有文本命中过滤。SQLite 仍为 FTS5 过滤，PostgreSQL 为标准 substring，JSON/InMemory 为兼容 substring。

既有 `MemoryStore` 是兼容组合接口，`list` 对自定义旧实现可选；四个内置实现均明确实现 `MemoryRepository`。默认 Retriever 的无 query 访问采用 list，旧自定义 Store 仍可通过 recall 工作。没有改变融合公式、候选策略、Context 权重或 Answer 行为。

已批准/未确认、private、scope、workspace 的职责保持阶段 0 结论。底层不默认强制 userConfirmed；Injection 的确认、公有和 workspace 规则继续在消费者侧执行。

## 1B：写入与一致性

### 身份与快照

InMemory 的逻辑键改为序列化元组 `(user, scope, scope identity, key)`，幂等键为 `(user, request key)`，避免 task/agent/user 包含冒号时互相覆盖。事件所有权索引替代逐条扫描历史判断用户归属；查询仍使用同样的资格过滤。

写入先拥有请求快照，返回值、历史和事件导出都是独立快照；修改调用方对象不修改存储或已生成的幂等回执。重试返回原写入的事件与版本，即使之后已更新或遗忘，也不恢复旧状态。

JSON value/metadata 采用 JSON 规范化，拒绝循环和稀疏数组，避免不同存储丢字段或把洞转换为 null。确定性 merge 将 `__proto__`/`constructor` 当作普通数据键；不是语义归并。

JSON 只做兼容加固：校验 ledger 事件，验证重复事件身份，原子发布文件，故障映射为 STORAGE_ERROR。Forget 幂等键也保留在重放状态，不能被新的 remember 复用。没有新增 JSON 检索架构；仍不承诺断电耐久性和陈旧锁恢复。

### 事务与并发

SQLite 继续使用 BEGIN IMMEDIATE；真实触发器故障验证：当前状态已更新但事件插入失败时，当前状态、事件、FTS 一起回滚；遗忘删除失败时，forget 事件也回滚。失败请求的幂等键不被消耗，修复故障后可重试。

PostgreSQL 在事务内先锁用户/请求身份，再锁逻辑记忆身份；负/正整数空间分开，所有 writer 遵守相同顺序。锁的 hash 冲突只增加串行化，不合并数据。随后读取当前状态、完成 CAS/merge，事件记录数据库最终物化值。此锁用于首次写入、同请求重试及 merge 的竞争边界，不能用 pg-mem 的 no-op 锁证明真实互斥。

连接与驱动错误标准化为 STORAGE_ERROR，不回显驱动正文；初始化 Promise 失败后允许再次尝试。没有自动重试未知结果的写入，调用方必须使用原幂等键确认结果。

补验修复 ROLLBACK 本身失败时的驱动正文泄露与连接复用，Remember/Forget/Migration 丢弃不确定连接。SQLite 的幂等检查补充事件类型，避免 `null` 请求将 Forget 错认成 Remember。真实 PostgreSQL 额外验证原幂等键核实丢失的 COMMIT 成功回执；详见 1B。

### 迁移

没有增加 SQL schema 版本。SQLite/PG 拒绝高于当前 runtime 的 schema 版本；SQLite 用中途 DDL 故障验证版本标记与表一起回滚并可重试。既有旧版 SQLite 升级、事件导入/导出和版本链测试继续运行。重复事件导入故障验证目标库没有半导入的 current/event/FTS 状态。

## 1C：分页与能力声明

普通 Recall/History 输出 cursor v2，绑定 user、agent、task、includePrivate，以及 key/kind/scope/query 或 memoryId。页大小不进指纹，可以在下一页改变 limit。跨过滤器或跨入口复用返回 VALIDATION_ERROR。

**legacy cursor 策略：拒绝未绑定游标，明确要求从第一页重启。** 无法从旧 token 恢复原过滤条件，不静默接受。cursor 是不透明位置标记，不是权限凭据，也不是加密/签名 token；资格过滤始终独立执行。带 query 的 Retrieval cursor 保留已有协议。

排序仍是 `(updatedAt DESC, id DESC)`。同一静态集合不重复不漏项，等时间戳由 id 打破平局；并发更新下是 live keyset pagination，不提供 snapshot isolation。时间排序不算相关性排名。

PostgreSQL capability 从 `postgres_text` 更正为 `postgres_substring`；使用标准 `strpos(lower(...), lower(query))`，%/_ 被当作字面字符，不再放大成 SQL 通配符。不要求扩展，不声称 BM25/向量/语义检索。pg-mem 缺少 strpos，测试层仅为该标准函数补透明模型，必须重新测相同 evaluator 的 reference。

## 首轮独立验证结果（历史快照）

### 存储契约

同一套 56 个断言在干净旧源码得到 34 通过、21 失败、1 未验证；当前源码得到 55 通过、0 失败、1 未验证。21 个失败包括新契约缺失与真实缺陷，不能称为 21 个生产事故。具体旧失败名称保存在独立 before 报告。

| 存储 | 当前共享契约 | 证据限制 |
| --- | --- | --- |
| InMemory | 14/14 | 进程内状态，不承诺持久化 |
| JSON | 14/14 | 兼容 ledger、原子 rename；不是断电恢复保证 |
| SQLite | 14/14 | 本地真实 SQLite |
| PostgreSQL-pg-mem | 13/14；1 明确未验证 | 模拟器会丢失保留 JSON 键，相关断言跳过而不判通过 |
| 真 PostgreSQL | 17 个断言未运行 | 缺少显式隔离数据库环境；不能以 pg-mem 替代 |

### 故障与恢复

SQLite 5 个真实失败/回滚/迁移/导入测试通过；JSON 2 个失败发布/无效事件测试通过；PG 2 个初始化恢复与 SQL rollback/lock 顺序协议测试通过。PG 这两项不证明真实 rollback 或锁互斥。

单独运行 `npm run test:storage`：75 通过、0 失败、18 未验证（17 真 PG + 1 模拟 JSON 键）。跨进程 SQLite CAS/并发、JSON 多进程写入和旧版迁移测试同时保留。

### 质量、安全、稳定性、性能

分别使用阶段 0 的固定 core-baseline-v1、同一评测器，测干净旧源码与本阶段源码。逐存储、逐入口报告，保持 Required/Challenge 分开。完整执行结果与容量样本在阶段验证报告中记录，不能用工程测试通过替代检索质量或性能结果。

## 真 PostgreSQL 的独立验收入口

本次完整命令、质量/安全/稳定性及容量结果见 [独立验收记录](./phase-1-validation.md)。

首轮因环境缺少而未运行。后续已检测到本机 Docker，新增 `npm run test:storage:postgres:docker`；真实 PostgreSQL 17.11 的 26 项在三次新建实例中均通过，最新结果见 [补验记录](./phase-1bc-validation.md)。质量 harness 仍是 pg-mem。

```bash
OPEN_CONTINUITY_TEST_POSTGRES_URL=postgresql://test-user@127.0.0.1/open_continuity_test npm run test:storage
```

只接受显式 loopback URL 和 `open_continuity_test*` 数据库名，不读取 DATABASE_URL 或 PG 默认配置。每个测试创建随机 `oc_test_*` schema，结束时仅删除该测试自己创建的 schema。原生执行同一契约，再验证并发 merge/审计链、幂等重试、CAS 首次创建与真实事务回滚。未配置时明确 skipped；Docker 是显式测试入口，不成为默认运行依赖。

## 剩余风险与进入下一阶段

Lite/进程内/JSON 的本地契约证据已补齐；原生 PG 的本次事务互斥/JSON 键/rollback 已有独立证据，但 Team 仍是实现预览，原生检索质量、长期部署和版本矩阵未验证。JSON 掉电与 stale lock、分页并发快照、跨平台远端矩阵仍是独立工作，不能写成已解决。

此前不通过质量门禁的 Retrieval Spike 已保存 19 个文件的校验副本并移出当前工作区，未提交的专属测试也可恢复。阶段 0 数据、评测器及历史结果保留；Adapter/CLI/Capture/Injection 没有修改。没有 commit 或 push，不自动进入阶段 2。
