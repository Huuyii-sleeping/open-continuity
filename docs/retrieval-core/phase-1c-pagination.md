# 阶段 1C：分页、权限与能力声明

本页只讲读路径的存储契约，不讲事务恢复；写路径见 [1B](./phase-1b-writes.md)。完整命令与回归结果见 [补验记录](./phase-1bc-validation.md)。没有引入 BM25、RRF 新公式、向量或 Answer。

## 明确的分页契约

结构化 `MemoryRepository.list` 不接受 query；`MemoryStore.recall` 保留旧文本查找语义。列表按 `updatedAt DESC, id DESC`，历史按 `createdAt DESC, id DESC`。时间排序是列表顺序，不是相关性排序。

Recall/History 的 cursor v2 绑定入口、user、agent、task、private 及全部过滤条件；页大小不进入指纹，可以改变 limit。换身份/过滤器/入口返回 `VALIDATION_ERROR`。旧未绑定游标需要从第一页重启，不推测原条件，不静默兼容。

cursor 不是签名或授权凭据。调用方可以构造新位置或指纹，但查询必须独立执行资格过滤。不会因为持有 cursor 获得另一个用户、Agent、task 或 private 的数据。

## 本次补验

共享 suite 新增两组断言：

- 畸形编码、超长 token、null/空 JSON、无效时间，对 Recall/History 返回稳定的校验错误。
- 构造合法且指纹匹配的 cursor，混入其他 user/agent/task/private 夹具，仍只能读取原本有权限的记录与历史。

已有断言继续覆盖同时间戳的 id tie-break、静态集合无重复/遗漏、改变 page size、跨过滤器/入口拒绝与 legacy 重启。相同测试在 InMemory、JSON、SQLite、pg-mem 和原生 PostgreSQL 执行。

## 能力声明与安全策略

| 路径 | 已实现 | 不承诺 |
| --- | --- | --- |
| SQLite | FTS5 命中过滤、短查询 substring、时间/id 分页 | 当前没有 BM25 relevance 排名 |
| PostgreSQL | 标准 `strpos` 字面 substring fallback、相同资格过滤/分页 | 不声称原生全文相关性、额外扩展或向量 |
| JSON | 兼容 ledger 和既有 substring | 不在全量扫描上继续发展新检索架构 |
| InMemory | 同一过滤/幂等/版本/对象副本契约 | 不持久化，不提供数据库事务 |

`postgres_substring` 如实反映当前实现。pg-mem 的锁/回滚不能证明原生行为；本次的真实 PostgreSQL 17.11 存储结果单独记录，不把质量 harness 的 pg-mem 指标改名成原生指标。

Recall 依旧允许未确认记忆；Context/Injection 才实施 userConfirmed 的消费者策略。没有放宽 private、scope 或确认边界；workspace 由 Adapter/Injection 层执行，本次没有修改它们，也没有声称原生 PG 的共享存储 suite 验证了 workspace。

## 接受的限制

这是 live keyset pagination。静态集合的稳定性不等于并发 snapshot：翻页期间更新/删除可能改变集合；随机 UUID 的等时间全序也不等于跨数据库重建的同序。相关性和当前/旧事实的选择挑战继续留给阶段 2/3，不用游标安全的通过结果替代检索质量。
