# 2A：统一候选证据契约

代码入口：`src/core/candidate-search.ts`。不修改旧 `ResolvedMemory.retrieval` 或公共 `RecallResult`，避免悄悄改变已有分数含义。

## 一条命中需要说明什么

| 字段 | 含义 | 禁止混淆 |
| --- | --- | --- |
| `memory` | 当前有效记忆快照 | 不是原始对话或旧版本事件 |
| `channel` | exact / structured / full_text | 不把所有候选都写成全文命中 |
| `channelRank` | 本次有界通道结果的一基位置 | 不是跨通道排名，也不保证是相关性 |
| `rankMeaning` | relevance / filter_order / match_order | 时间顺序必须标记为非相关性 |
| `score` | model、value、direction | SQLite BM25 越小越好；没有分数则 value=null |
| `match` | type、reason、显式过滤字段及可选 termCount | 条件匹配不等于能回答问题 |

数值分数只用于 SQLite 原生 BM25，模型名 `fts5_bm25`，方向 `lower_is_better`。Exact 是 `key_equals`，Structured 是 `explicit_filters`；它们及 substring fallback 使用 `model=none/value=null/direction=not_applicable`，不编造统一相似度。不同通道分数不直接相加。

## 批次与输入边界

`CandidateSearchResult` 返回 `status=ok|skipped`、可解释的 `skippedReason`、`implementation`、`ordering` 与 `truncated`。`ok + hits=[]` 表示检索过但未命中；`skipped + implementation=not_run` 表示该通道不适用。`truncated=true` 仅表示 top-K 后还有符合条件的匹配，不代表总数。

输入沿用既有身份、scope 与过滤字段的校验；额外接受 channel 与默认 false 的 `requireUserConfirmed`。拒绝未知字段、cursor、NUL、超过 2048 个 JS 字符的 query、超过 32 个空白分隔项的 query、非法 limit。不是将模型传来的身份自动认证为真实身份。

`CandidateRetrieval.retrieve` 对最多三个唯一通道依次调用，结果保持独立；没有 fused score、去重并集、最终选择或答案。Store 必须在预算截断前完成资格过滤与显式确认过滤；最终消费者还需遵守自己的策略。

## 兼容性

`MemoryStore.searchCandidates` 对旧自定义 Store 是可选字段；四个内置实现显式实现 `CandidateSearchStore`。未实现该接口的 Store 不能被包装成“支持 BM25”的假实现。公共 MCP/HTTP 能力仍描述旧默认查询路径，不因 staged API 存在就把 BM25 宣称为默认能力。
