# 阶段 2：独立候选召回

本页保留阶段 2 独立交付时的范围。2026-10-23 复测通过后，公共接入已在 [阶段 3 首个增量](./phase-3-ranking.md) 实现；下面的“公共行为不变”描述阶段 2 当时，不是当前默认状态。

阶段 1 负责存储可信；阶段 2 负责独立产生有出处的候选，不融合、不生成答案。设计分开看：[2A 证据契约](./phase-2a-contract.md)、[2B 召回实现](./phase-2b-retrievers.md)、[2C 验收](./phase-2c-validation.md)。

## 运行边界

新增 `CandidateRetrieval` 与内置 Store 的 `searchCandidates`，是可直接调用的 **staged Core API**，不是新增 MCP/HTTP 工具。默认 `memory_recall`、`memory_context`、`memory_query` 仍走旧 `RetrievalPipeline`；其 RRF、Context 权重、权限策略和游标不切换。旧路径仍不能宣称真实相关性融合；阶段 3 才处理接入、排序版本、融合与回执迁移。

```text
CandidateRetrieval（显式 Core 调用）
  -> Exact       -> 独立 key 候选与等值信号
  -> Structured  -> 独立过滤候选，不代表问题相关
  -> Full Text   -> SQLite BM25 或明确 substring fallback
  -> 三份有界结果；不并集、不融合、不注入

MemoryService.recall/context/query（原公共入口）
  -> 既有 RetrievalPipeline；本阶段保持行为
```

## 使用

```ts
import { CandidateRetrieval } from "./src/core/candidate-search.js";

const candidates = new CandidateRetrieval(store);
const results = await candidates.retrieve({
  userId: "fictional-user", agentId: "fictional-reader",
  query: "sqlite WAL", kind: "decision", limit: 20,
});
// results 各自包含 channel/status/hits/truncated/ordering/implementation。
// Structured 可能只是 kind=decision，不能直接当作回答证据注入。
```

每通道 `limit` 为 1–100，默认 20；最多三通道。输入先校验并复制，失败返回错误，不用空成功批次掩盖存储故障。一个通道失败时整个显式调用报错，不返回貌似完整的部分结果；公共 Hook 的 fail-open 行为未修改。

## 非目标与证据限制

- 不添加 Adapter、外部模型、embedding、向量库、语义改写、翻译或模型 rerank。
- 不改 SQL schema、FTS trigram tokenizer 或列权重；无数据迁移。
- 候选批次不是分页 API：不接受任何 cursor。原列表/历史/公共检索游标继续使用旧契约；候选相关性分页留到阶段 3 单独设计。
- `userId/agentId` 必须由可信调用边界提供，本 API 不负责认证，也不以提示词声明授予身份。保留 user/agent/task/private；`requireUserConfirmed` 只能额外收紧，不改变 Recall 默认允许未确认、普通 Context 既有策略与 Injection 的强制确认边界。
- workspace 仍由 Adapter/Injection 边界实施，本次没有修改或声称重验该边界。
- SQLite BM25 使用整张 FTS 表的语料统计；返回前做资格过滤，但不承诺跨用户语料统计/排名侧信道隔离。local-first 不是云端多租户安全证明。
- JSON 仅兼容委托，不新建索引架构；PostgreSQL 仅字面 substring fallback，不声称 BM25 或原生全文相关性。
- 原生 PG 共享契约通过不等于原生检索质量评测；长期并发、断电、性能 SLO、发布矩阵仍未验证。
