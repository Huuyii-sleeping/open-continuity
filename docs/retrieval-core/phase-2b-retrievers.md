# 2B：独立召回通道

入口：`src/core/candidate-search.ts`、`src/core/memory-store.ts`、`src/sqlite/sqlite-memory-store.ts`、`src/postgres/postgres-memory-store.ts`。四条路径共同执行身份与资格规则，不通过放宽 scope/private/确认边界增加召回。

## Exact

使用显式 key，否则把去除首尾空白的 query 作为完整 key；精确、区分大小写。两者同时存在而不一致时返回 `key_query_mismatch`，没有 key/query 时跳过。仍应用其它明确过滤与权限条件；多个可见 scope 的同名 key 可同时命中，以 updatedAt/id 稳定排序，不宣称相关性。

## Structured

只有显式 key/kind/scope 至少一项存在才运行；只有身份或 taskId 可见性上下文不算检索条件。独立查询 Store，不与 Exact/Full Text 求交集，query 不影响此通道的过滤结果。

输出 `rankMeaning=filter_order`，按 updatedAt/id 排序。它可找回“某任务的所有决策”，但不能把其中每条都当成“为什么选 SQLite”的相关证据。因此阶段 2 不将独立 Structured 候选接进旧 RRF 或 Injection，避免无证据问题被任意同域记忆填充。

## SQLite Full Text

1. query 去除首尾空白，按空白拆为去重的字面项；不删停用词、不纠错、不翻译、不改写语义。
2. 每个至少三个 Unicode 码点的项作为完整双引号 FTS phrase；转义内部引号，再以 AND 连接。用户文本里的 OR/NOT/列选择符不能成为 FTS 操作符。
3. 这些长项可分布在 key/value 的不同列；同一项仍保持字面连续匹配。少于三个码点的项用参数化 `instr(lower(...),lower(?))`，逐项 AND 约束。只有短项时全走此 fallback，不能任意补候选。
4. 有长项时使用原生 `bm25(memories_fts)`，按原始分数升序，再以 updatedAt DESC / id DESC 破平。无长项时无相关性分数，仅匹配后按时间/id 排序。
5. user、agent、task、private、显式 key/kind/scope、可选确认条件都在 SQL 中先过滤，再 LIMIT K+1；额外一项仅计算 truncated。

FTS5 的 BM25 越小越相关，且依赖整表语料统计；短查询扫描不享有同样索引/分数能力。[SQLite 官方说明](https://sqlite.org/fts5.html#the_bm25_function)。没有修改 trigram schema、列权重或偷偷加入 freshness boost。BM25 只是字面相关性，不理解否定、当前/旧事实或概念改写。

## 其它存储

| 路径 | Full Text 实际能力 | 排序/分数 |
| --- | --- | --- |
| PostgreSQL | 标准 `strpos`，完整 query 的字面 substring；无需扩展 | 时间/id，无分数；`postgres_substring_fallback` |
| InMemory | 兼容的完整 query substring | 时间/id，无分数；`inmemory_compatibility` |
| JSON | 刷新兼容 ledger，委托 InMemory | 时间/id，无分数；`json_compatibility` |

fallback 不具备 SQLite 的多词跨列 AND/BM25 能力，不能静默声称一致的文本检索质量。共同契约保证身份/过滤、数据快照、预算、幂等更新后索引可见性和失败语义；不强求不同检索引擎产生相同相关性结果。
