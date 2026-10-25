# 分叉时的契约、能力与不变量（历史）

本文描述 `core-v2` 分叉点 `e23207aa9e746c71a599af8e2a0c913c5d59bf94` 的实际行为；该提交是阶段开始时的 `origin/main`。本文不描述 Retrieval Core v2 Spike，也不混入随后合并的 Adapter hardening。

阶段 1/2/3 的后续实现没有回写这份历史快照。当前契约见 [阶段 3 排名与证据](./phase-3-ranking.md) 和 [兼容性](../compatibility.md)。

## 当前调用链

```text
HTTP / MCP
  → AccessPolicy
  → MemoryService
      remember → MemoryStore.appendRemember
      recall   → RetrievalPipeline → MemoryStore.recall
      context  → ContextPackBuilder → RetrievalPipeline
      query    → AgenticQueryEngine → RetrievalPipeline + MemoryStore.history
      forget   → MemoryStore.appendForget
      history  → MemoryStore.history

Injection Hook
  → workspace allowlist
  → conservative query extraction
  → MemoryService.context(requireUserConfirmed=true, includePrivate=false)
  → timeout/failure fail-open
```

Workspace allowlist 属于 Capture/Injection 边界，不属于 `MemoryStore` 或 `RetrievalPipeline` 的输入。`includePrivate=true` 由 HTTP/MCP `AccessPolicy` 控制；内核内部调用被视为可信调用方。

## 当前 MemoryStore 契约

```ts
interface MemoryStore {
  appendRemember(input): MemoryReceiptLike;
  appendForget(userId, agentId, memoryId, taskId?, includePrivate?): MemoryReceiptLike;
  recall(input): RecallResult;
  history(input): HistoryResult;
  close?(): void;
}
```

该接口同时承载持久化、可见性过滤、字符串查询和分页。阶段 1 需要决定是否继续保持该边界，还是拆出纯存储原语与 Retriever；在设计确认之前不得直接把 scored search 永久塞进现有接口。

## 安全与数据不变量

### 身份和 Scope

- 所有查询必须绑定 `userId`，不得跨用户读取。
- `user` scope 对同一用户的 Agent 可见。
- `agent` scope 只对 `ownerAgentId === requesting agentId` 可见。
- `task` scope 必须提供相同 `taskId` 才可见。
- `private` 默认不可见；只有显式 `includePrivate=true` 且外层策略允许时才可读取。
- 资格过滤必须发生在候选进入排序之前。

### UserConfirmed

- `MemoryStore.recall` 和普通 `MemoryService.context` 默认不会过滤未确认 Memory。
- Injection 明确创建 `requireUserConfirmed=true` 的 Context Policy，并固定 `includePrivate=false`。
- 因此 `userConfirmed` 当前是消费者策略，不是所有 Recall 的全局权限字段。后续阶段若改变该语义，属于公共行为变更，必须单独设计和迁移。

### 写入、版本和审计

- 逻辑唯一键为 `(userId, scope, scopeIdentity, memoryKey)`。
- 幂等键按用户隔离；同一幂等键携带不同请求必须返回 `IDEMPOTENCY_CONFLICT`。
- Replace/Merge 产生递增版本，并保留 supersedes 信息。
- `expectedVersion` 提供 CAS；不匹配返回 `VERSION_CONFLICT`。
- 当前状态和审计事件必须在同一事务中更新。
- Forget 删除当前状态但保留 `memory_forgotten` 审计事件。

### 分页

- 无 query 的存储分页使用 `(updatedAt DESC, id DESC)`。
- 带 query 的 Retrieval cursor 绑定 user、agent、query、过滤条件和 includePrivate 的指纹。
- 无 query 的 legacy cursor 只编码时间与 id，不绑定过滤条件；跨过滤器复用尚未被阶段 0 契约禁止，是阶段 1 需要决策的兼容性风险。

## 存储能力矩阵

| 路径 | 持久化与事务 | 当前查询实现 | 当前排序 | 验证状态 |
| --- | --- | --- | --- | --- |
| InMemory | 进程内；无持久化 | `key + JSON(value)` substring | `updatedAt DESC, id DESC` | 单元测试使用；未纳入 shared persistent contract loop |
| JSON | 原子 rename + 文件锁；兼容路径 | 委托 InMemory substring | `updatedAt DESC, id DESC` | shared contract 使用临时文件验证 |
| SQLite | `BEGIN IMMEDIATE`、WAL、schema migration、0600 | 查询长度 ≥3 时 FTS5 trigram phrase filter；短查询 substring | `updatedAt DESC, id DESC` | Lite 正式路径；无 BM25 排名 |
| PostgreSQL | 事务、row lock、CAS、advisory migration lock | `ILIKE %query%` | `updatedAt DESC, id DESC` | 主要由 pg-mem 验证；没有真实 PostgreSQL 环境证据 |

## 当前 RetrievalPipeline 的真实行为

| 名称 | 实际行为 | 结论 |
| --- | --- | --- |
| Exact | 将 query 当作 key 调用 `store.recall` | 可产生精确候选，但没有独立 score contract |
| Structured | 对 store 的结构化结果与 Exact/Full-text 已命中 ID 取交集 | 不是独立候选生成器；当前是重复匹配信号 |
| Full-text | 调用各 Store 的 query recall | SQLite/Postgres/InMemory 的能力和语义不一致 |
| Channel rank | 使用 Store 返回数组的位置 | 实际是 `updatedAt/id` 顺序，不是真实相关性排名 |
| RRF | 对上述 channel position 执行 `1 / (k + rank)` | 算法存在，但输入 rank 不是相关性 rank |
| Stable tie-break | fused score 相同时使用 `updatedAt/id` | 行为稳定，但不能弥补输入排名语义错误 |

## Context 与 Agentic Query

- Context Pack 先使用 Retrieval score，再叠加 task scope、agent scope、userConfirmed 和 purpose/kind 权重。
- 默认 `MemoryService` 的 Context Policy 不要求 userConfirmed；Injection 和 quality evaluator 显式要求。
- Token 估算使用 UTF-8 bytes / 4，超预算时整条 Memory 省略，不截断内容。
- Agentic Query 是确定性 L0-L3 规划器，可拆分有限 subquery、加载历史并给出 sufficiency/fallback。
- 当前没有语义 Planner、图遍历、模型回答或模型 Rerank；`memory_query` 返回计划、证据和 Context Pack，不生成自由文本答案。

## 事实—声明差异

以下差异在阶段 0 只记录，不修改：

1. Runtime capability 将模式称为 `hybrid`，但 RRF 输入是存储时间顺序，不能解释为成熟混合相关性排序。
2. SQLite capability 声明 `fts5` 是事实，但实现只用 FTS5 过滤命中，不使用 BM25 排名。
3. PostgreSQL capability 声明 `postgres_text`，实际实现是 `ILIKE` substring；该声明需要在阶段 1/2 更正。
4. Structured channel 不是独立 Retriever，却参与 RRF 加分，可能重复计算过滤匹配。
5. Quality evaluator 尚无 Recall@K、MRR、nDCG 和排序稳定性。
6. Quality evaluator 的 false injection 口径不包含 forbidden distractor，可能在错误排序时仍报告 0。
7. shared storage contract 没有覆盖 InMemory，也没有完整验证跨存储 query 排序、cursor 兼容和真实 PostgreSQL 行为。

## 阶段职责归属

| 关注点 | 负责阶段 |
| --- | --- |
| 事务、幂等、版本、审计、稳定分页 | 阶段 1：存储内核 |
| Exact/Structured/Lexical 候选产生 | 阶段 2：候选召回 |
| raw score、rank、RRF、boost、冲突事实 | 阶段 3：排序与事实选择 |
| public/userConfirmed/workspace/Token 选择 | 阶段 4：Context |
| 证据组合、引用、置信度、拒答 | 阶段 4：Answer |
| 超时、降级、迁移、故障、规模和恢复 | 阶段 5：生产可靠性 |
| Semantic、Embedding、模型 Rerank | 阶段 6：高级能力 |
