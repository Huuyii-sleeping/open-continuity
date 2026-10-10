# OpenContinuity 架构与路线图

## 1. 产品定位

OpenContinuity 是一个 local-first、用户可控的跨 Agent 共享记忆基础设施，而不是通用文档问答或 RAG 框架。当前产品化重点是把共享记忆接入 Agent 的真实对话闭环：Conversation Capture 从第三方 Agent 的官方可观测扩展面读取对话，先写入短期 Inbox；经用户批准后再进入跨 Agent 共享记忆；Memory Injection 在下一轮 Prompt 提供受预算约束的轻量上下文；Agent 需要更多证据时再通过 MCP 主动查询。

Conversation Capture 与 Injection 是共享记忆的适配入口和出口，不是对共享记忆的替代。系统不修改第三方 Agent 源码，不承诺 MCP 自动获得完整对话，也不提供云端存储或主动上传服务。

### 当前主线（V1.2 前置实验）

当前优先验证一条完整、可迁移的 Adapter 链路，而不是继续扩展检索算法：

```text
Agent runtime -> Capture Adapter -> Conversation Inbox
             -> candidate policy -> explicit approval
             -> shared memory store
             -> Injection Adapter (light context)
             -> MCP deep query (on demand)
```

这条链路的验收重点是：能否读取 Agent 官方扩展面暴露的完整可观测内容、能否增量且幂等地保存、能否只把有价值且经批准的内容沉淀为长期记忆、能否在下一轮安全注入，以及能否在需要时回退到 MCP 深搜。Trae app-server、Claude Code Hooks 与 Codex app-server 已经验证同一 Adapter 契约可以覆盖“常驻增量同步”和“生命周期事件驱动”两种接入形态；Codex 仍保留 MCP 作为深搜通道。

项目的四个设计关键词是：

- **Portable**：记忆能够跨 Agent、客户端和厂商迁移。
- **Adaptive**：根据查询复杂度、数据规模和成本预算选择检索路径。
- **Evolving**：记忆支持覆盖、归并、冲突检测、条件化和版本演化。
- **Governed**：记忆具有来源、授权、访问控制、审计和撤销能力。

RAG、Agentic Retrieval、多路召回和图谱只是 Read Pipeline 的可插拔策略，不是产品本身的全部定义。

## 2. 当前事实与设计目标

### 当前 Developer Preview 已实现

- MCP stdio 与 HTTP 两种接入方式。
- `memory_capabilities`、`memory_remember`、`memory_recall`、`memory_context`、`memory_query`、`memory_history`、`memory_forget`、`memory_handoff_create`、`memory_handoff_resume` 九个工具。
- 本地 CLI 初始化、Agent 连接与断开、只读 doctor、记忆查询/历史/删除。
- Trae、Claude Code 和 Codex CLI 连接器，写配置前备份并为每个客户端绑定稳定身份。
- 带版本、当前状态、完整事件和 SHA-256 校验的 Memory Package。
- task scope 的 Handoff Capsule，支持显式创建、跨 Agent 恢复和过期状态。
- `user`、`task`、`agent` 三种 scope 和 public/private 访问策略。
- 当前有效记忆与不可变事件历史分离。
- SQLite 本地正式存储、JSON 兼容存储与 PostgreSQL 事务存储。
- SQLite FTS5 全文检索、WAL 和本机多进程并发写入。
- JSON ledger 到 SQLite 的显式导入及 SQLite 到 JSON 的事件导出。
- 可插拔 `MemoryRetriever` 接口，默认 exact、structured、full_text 三路检索。
- 带 query 的请求使用 RRF 融合，返回每条记忆的命中通道、rank 和融合分数。
- 检索游标绑定查询指纹，防止跨查询条件复用。
- 显式 Lite/Team Profile Resolver、默认存储映射、配置冲突校验和候选预算。
- HTTP health/capabilities 与 MCP capability discovery。
- 基于 Agent、task、purpose 与 token budget 的确定性 Context Pack。
- Context Pack 为入选项返回排序原因，为省略项返回 token 或数量预算原因。
- Lite 与 Team 使用同一 Context Pack 契约，并由 Profile 提供不同默认/最大预算。
- `expectedVersion` compare-and-set 防止多个 Agent 基于过期状态静默覆盖。
- `replace` 和确定性 JSON 对象 `merge` 两种写入模式。
- 当前记忆和事件历史记录 version、supersedes、置信分数及其依据。
- L0-L3 查询复杂度分类、显式/确定性子查询拆分和可审计检索计划。
- 多步 recall、按候选 memoryId 的历史扩展、证据去重融合与充分性状态。
- Profile 级步骤、超时、子查询和历史事件预算，以及显式确定性降级原因。
- 幂等写入、分页游标、来源 Agent、版本与用户确认标记。
- PostgreSQL 迁移、并发初始化锁、事务更新和遗忘。
- 实验性 Trae Conversation Capture：app-server 同步与 `watch` 轮询、基于 `updatedAt` 的增量读取、统一回合/消息模型、独立 SQLite Inbox、规则候选提取、敏感字段脱敏/阻断、7 天保留清理和人工 approve/reject。
- 实验性 Trae Injection Adapter：`UserPromptSubmit` command hook、一键安装/检查与备份、workspace allowlist、已批准 public 记忆的轻量 Context Pack、200ms 超时、fail-open 和不含 Prompt 原文的本地 Receipt。
- Trae Adapter 成熟化基础：幂等 `setup trae`、分层 `doctor trae`、可安全重载的 launchd 生命周期，以及与 Inbox 同事务推进的 thread/turn/item checkpoint。
- 通用 `CaptureAdapter` / `InjectionAdapter` 契约、按 Adapter source 隔离的 checkpoint 与查询，以及 Capture/Injection 双 workspace allowlist。
- Claude Code Adapter：官方 `Stop` transcript Capture、`UserPromptSubmit` Injection、幂等 `setup/doctor`、已有设置保留与备份、逐记录 workspace 过滤和自注入反馈过滤。
- Codex CLI Adapter：官方本地 `app-server --stdio` Capture、`Stop` Capture Hook、`UserPromptSubmit` Injection Hook、幂等 `setup/doctor`、`$CODEX_HOME/hooks.json` 备份与保留、reasoning 内容不落盘，以及 app-server 不可用时明确降级为 MCP-only。
- 候选 exact 去重和跨 Agent occurrence 合并；对确定性高相似候选要求显式指定被替换 memory，并复用 `expectedVersion`/`supersedes` 生成可审计的新版本。
- 本地瞬时数据治理：原始回合默认 7 天、pending 候选默认 30 天、Receipt 默认 30 天且最多 5000 条；支持自动/手动 cleanup、显式 purge，并保留长期共享记忆。
- Capture/长期记忆 SQLite 与 Receipt 文件使用 owner-only 权限；Adapter 具备契约测试、故障恢复、1000-cycle soak 和完全虚构的进程黑盒。

### 尚未实现

- embedding、pgvector、语义向量召回和 rerank。
- 基于模型的语义查询规划、知识图谱和关系多跳推理。
- 基于模型的记忆提取、语义冲突判断、条件化偏好归并和归并撤销；当前 Capture 使用显式信号规则与确定性字符相似度，只做保守去重/替换门禁，不冒充语义理解。
- 基于模型的语义压缩与特定模型 tokenizer 精确计数。
- 多租户、OAuth、管理后台和企业级策略引擎。

文档中的后续能力均为设计目标，不能视为当前运行时承诺。

## 3. 三种部署 Profile

### Lite：个人本地版

目标是一个命令即可启动，不要求安装数据库服务。个人数据量通常不大，但仍需要索引、事务、稳定分页和全文检索，因此正式存储选择单文件 SQLite，而非 JSON。

默认查询路径：

```text
scope / task / time 过滤
  -> key 与结构化字段精确匹配
  -> SQLite FTS 全文召回
  -> 去重、时效与置信度排序
  -> 轻量 Context Pack
```

JSON 只承担演示、排障、备份和导入导出。Lite 默认不启动远程服务、不调用外部模型，也不为普通 `memory_recall` 启用多步推理；调用方可以显式使用有严格预算的 `memory_query`。

### Team：团队共享版

目标是支持多用户、多 Agent、多进程或多实例访问，正式存储使用 PostgreSQL；向量能力优先采用 pgvector，避免额外维护一套事实来源。

默认查询路径：

```text
结构化/精确召回 ---\
PostgreSQL 全文召回 ----> 权限过滤 -> RRF 融合 -> 可选 rerank -> Context Pack
pgvector 语义召回 ----/
```

Team Profile 不是每次都运行所有召回器。查询路由器根据查询类型、结果质量、延迟和成本预算决定是否启用向量召回与重排。

### Enterprise：企业治理版

目标是复杂权限、多租户、大规模历史和跨实体推理。在 PostgreSQL 之外可以使用对象存储保存原始证据，并在关系查询确有价值时接入图存储。

复杂查询路径：

```text
查询分类与复杂度评估
  -> 必要时拆解问题和生成检索计划
  -> 多路召回与关系多跳
  -> 来源、权限、时效和冲突验证
  -> 证据压缩与 Context Pack
```

Agentic Retrieval 只服务无法通过单次检索可靠回答的问题。简单查询始终优先走低延迟确定性路径。

## 4. 统一架构

```text
Agent Connectors
MCP / HTTP / CLI / future SDK
              |
              v
Unified Memory Protocol
identity / scope / permission / capability / budget
              |
      +-------+-------+
      |               |
      v               v
Write Pipeline     Read Pipeline
validate           classify
extract(*)         bounded plan
  deduplicate        recall / history
  review conflict    fuse / rerank(*)
version            build Context Pack
audit              sufficiency / receipt
      |               |
      +-------+-------+
              |
              v
Storage Profiles
SQLite / PostgreSQL / optional vector and graph indexes

(*) 后续版本能力
```

Agent Capture 在统一协议之前增加一层可撤销的本地暂存：

```text
Trae app-server / Claude Stop transcript / Codex app-server
                    | Capture Adapter + workspace allowlist
                    v
         Conversation Inbox (capture.db, turn TTL)
                    | normalize + quality gate + candidate review
                    v
              pending candidates (separate TTL)
                    | explicit approve / explicit replacement
                    v
           Write Pipeline (memories.db, version history)
```

Injection Adapter 是反方向的轻量读路径：

```text
Trae / Claude UserPromptSubmit
        |
        v
workspace allowlist + local config
        |
        v
public + user-confirmed memory_context
        |  <= 800 estimated tokens / <= 8 memories / <= 200 ms
        v
additionalContext (untrusted reference data)
        |
        +--> Injection Receipt (prompt fingerprint only)
```

Injection 不承担深度检索、模型推理或长期对话保存。Agent 需要更多证据时，仍通过 MCP `memory_recall` / `memory_context` / `memory_query` 主动查询；Hook 失败、超时或未命中都返回继续执行的空动作。

Inbox 保存“用于判断什么值得沉淀的可观测证据”，长期记忆只保存用户批准后的结构化结果。两层隔离避免把“工具看见过某段对话”等同于“这段对话已经成为共享记忆”。

三个 Profile 必须复用同一个 Protocol、Write/Read Pipeline 接口和结果模型。Profile 只决定启用哪些存储适配器、检索通道与预算策略，不能复制三套互相漂移的业务逻辑。

## 5. 与普通 RAG 的区别

### 5.1 统一记忆语义

记忆不是任意文档切片。每条记忆至少拥有用户、来源 Agent、kind、scope、敏感级别、用户确认状态、版本和事件来源。不同 Agent 使用的是同一事实层，而不是各自复制一份向量库。

### 5.2 记忆演化与冲突归并

新写入可能覆盖旧事实，也可能只是增加适用条件。例如“偏好详细解释”和“编码任务希望简洁”不应互相覆盖，而应归并为带场景条件的偏好。运行时需要保留演化链和归并依据，避免检索同时返回彼此冲突的旧片段。

### 5.3 面向 Agent 的 Context Pack

同一事实层可以按 Agent 能力、任务类型和 token 预算产生不同结果：编码 Agent 优先获得仓库约束，浏览器 Agent 优先获得操作偏好。Context Pack 只改变呈现和排序，不绕过 scope 或权限。

### 5.4 可解释的检索回执

后续查询结果应说明记忆为何被选中、来自哪里、是否由用户确认、使用了哪些召回通道、置信度如何、是否取代旧记忆。企业可以据此审计，个人也可以查看和撤销。

### 5.5 可移植的 Memory Package

后续定义稳定的导入导出包：

```text
memory-package/
  manifest.json
  memories.jsonl
  events.jsonl
  relations.jsonl       # 可选
  attachments/          # 可选
  signatures/           # 可选
```

可移植格式不绑定 SQLite、PostgreSQL 或图数据库，也不强制导出调用方无权查看的记忆。

## 6. 自适应检索原则

检索能力的选择同时考虑：

- 数据规模与可用索引。
- 问题是否需要语义匹配、跨时间总结或关系多跳。
- 当前 Agent 的身份、任务 scope 和访问权限。
- 可接受延迟、模型调用成本和 token 预算。
- 候选结果是否足够可靠，是否存在冲突或证据缺口。

建议的复杂度等级：

| 等级 | 典型问题 | 策略 |
| --- | --- | --- |
| L0 | 指定 key 的用户偏好 | 已实现：精确 key 查询 |
| L1 | 查找相关偏好或决策 | 已实现：单次确定性混合召回 |
| L2 | 查询多个主题或一个决策的演化 | 已实现基础版：多子查询 + 定向历史扩展 + 证据融合 |
| L3 | 分析跨项目目标变化的原因 | 仅分类和尽力召回；图谱/语义多跳未实现并明确降级 |

系统从最低成本等级开始；只有结果不足或查询天然复杂时才升级，避免把所有请求都变成昂贵且不稳定的 Agentic RAG。

## 7. 版本路线图与验收标准

### V0.5：Lite Profile 与 SQLite（已实现）

- SQLite 实现完整 `MemoryStore` 契约。
- 支持事务、索引、FTS 和现有 scope/private 语义。
- JSON 导入到 SQLite，并能导出兼容 JSON。
- 默认个人启动不依赖 PostgreSQL。
- JSON、SQLite、PostgreSQL 运行相同的契约测试。

### V0.6：统一 Retrieval Pipeline（已实现基础版本）

- 定义可插拔 Retriever、Fusion 和 Reranker 接口。
- 首先实现精确、结构化和全文三路查询。
- 使用 RRF 融合候选并通过查询指纹保护分页游标。
- 每条结果保留来源通道、rank 与融合分数，不改变既有权限语义。
- Team Profile 的 pgvector 语义召回和 rerank 仍待实现。

### V0.7：Profile Runtime（已实现）

- `OPEN_CONTINUITY_PROFILE=lite|team|enterprise` 配置入口。
- Lite 默认 SQLite、每通道 50 个候选；Team 默认 PostgreSQL、每通道 100 个候选。
- 旧 `OPEN_CONTINUITY_STORE` 配置自动推导 Profile。
- Profile/Store 冲突和未实现的 Enterprise 明确拒绝启动。
- HTTP 与 MCP 统一公开当前能力和未启用能力。

### V0.8：Context Pack（已实现基础版本）

- 根据 Agent、任务、用途和 token budget 组织结果。
- 复用 Retrieval Pipeline 的去重结果，并提供稳定的逐行 JSON 输出契约。
- 能解释被选中的记忆和因 token/数量预算被省略的原因。
- Lite 默认/最大预算为 1024/4096，最多 20 条；Team 为 4096/16384，最多 50 条。
- 使用 `utf8_bytes_v1` 确定性估算；单条记忆超预算时整条省略，不做可能改变语义的截断。
- 模型语义压缩和精确 tokenizer 仍是后续可选能力。

### V0.9：记忆演化与高级检索回执（已实现基础版本）

- `expectedVersion=0` 支持仅创建；指定当前版本时使用 compare-and-set，冲突返回稳定的 `VERSION_CONFLICT`。
- `replace` 提供兼容的整体覆盖；`merge` 对 JSON 对象执行确定性深度归并。
- SQLite 使用写事务、PostgreSQL 使用带 version 条件的 UPDATE/UPSERT 保证并发版本检查。
- 事件同时记录调用方输入值和最终物化值，并通过 `supersedes` 指向被取代事件和版本。
- Recall 与 Context Pack 返回 version、supersedes 和调用方声明的置信依据。
- 语义冲突分类、条件化偏好自动归并及归并撤销仍待实现；系统不会用启发式规则冒充语义判断。

### V1.0：有边界 Agentic Retrieval（已实现基础版本）

- `memory_query` / `POST /v1/query` 提供 L0-L3 分类和可审计的确定性计划。
- 支持显式子查询、有限规则自动拆分、多步混合召回、按候选 memoryId 聚合历史，以及融合证据生成 Context Pack。
- 返回逐步状态、证据覆盖、`sufficient/partial/insufficient` 和机器可读 fallback 原因。
- Lite 默认/最大 3/4 步、1500/5000ms、3 个子查询、50 条历史事件；Team 为 5/8 步、3000/10000ms、8 个子查询、100 条历史事件。
- L3 关系/语义多跳当前标记 `unsupported_complexity`；系统不调用外部模型，也不把启发式检索冒充复杂推理。
- 超时会停止等待并忽略迟到的只读结果，但当前存储接口不能取消已经发出的底层查询。

### V1.1：Developer Preview 产品闭环（已实现基础版本）

- npm 可分发 CLI 与一键初始化。
- 三类 MCP Agent 连接器、固定身份、配置备份和断开。
- doctor、记忆管理、Memory Package 和 Handoff Capsule。
- Linux/macOS CI、兼容性矩阵、安全与贡献文档。
- SQLite 完整性检查、一致性备份、带恢复点的显式恢复和可复现 Lite 性能基准。

### V1.2：Adapter 产品化与协议深化（Beta 候选已完成基础闭环）

- 已完成 Trae Capture/Injection 的稳定性、安装诊断、真实只读探针和进程黑盒；Codex 也已完成 app-server 只读探针与独立进程黑盒，具体客户端版本变化仍需持续兼容验证。
- 已明确 Capture、短期 Inbox、候选审核、长期共享记忆、轻量 Injection 和 MCP 深搜的边界，并补齐保留/清理策略。
- 已抽象通用 Adapter 契约并实现 Claude Code、Codex 两个独立 Adapter；真实 Codex 持久化 `codex exec` smoke 与交互式 `/hooks → Trust all → prompt` smoke 已通过，真实 Claude Code 客户端 smoke 仍待对应环境验证；新 Codex 进程是否复用信任仍由客户端生命周期决定。
- 已实现确定性候选去重、保守冲突门禁和显式版本演化；基于模型的语义归并仍是后续可选能力。
- 下一步是在不改变本地优先和用户批准边界的前提下，收集真实 Beta 兼容数据，再决定各客户端兼容性维护与关系模型的优先级。

### 后续：关系能力与协议深化

- 关系模型和有明确收益的多跳查询。
- Memory Package 合并策略、签名和兼容性版本演进。
- 完成 Lite、Team、Enterprise 的能力协商与治理边界。

### V1.2 Conversation Capture 与 Injection（Trae + Claude + Codex 基础闭环已实现）

- Trae app-server capability probe、显式 thread 同步和基于 `updatedAt` + durable checkpoint 的 `watch`。
- user、assistant、tool、compaction 的统一可观测事件模型。
- completed/final-answer 完整性判断，临时 side thread 过滤和重复同步幂等。
- 规则型显式信号提取，候选默认 private/pending；普通批准保留 private，只有显式 `--share` 才成为默认跨 Agent 可读的 public 记忆。
- UserPromptSubmit 注入已实现基础版本：workspace 显式开启、public + userConfirmed 过滤、受限 Context Pack、超时与 fail-open、Receipt 审计。
- `setup trae` 已聚合 MCP、Hook、workspace allowlist 与 macOS launchd Capture；`doctor trae` 分层报告运行状态和必须人工确认的 Hook 信任/MCP 审批边界。
- `setup claude` 已聚合 MCP、双 Hook 与 workspace allowlist；Stop transcript Capture 不依赖常驻服务，并处理异步最终回复、workspace 切换和自注入反馈。
- `setup codex` 已聚合 MCP、app-server Capture、双 Hook 与 workspace allowlist；`thread/turns/list` 优先、旧版 `thread/read` 回退，reasoning 只保留类型标记；Hook 配置写入前备份且可幂等重跑。
- 候选 exact 重复会合并 occurrence；确定性高相似内容必须经用户指定目标后才能演化为新版本，不会静默覆盖。
- 原始回合、pending 候选和 Receipt 采用分层 TTL/数量限制，可查询、立即清理或显式清空瞬时层；长期共享记忆不受瞬时 purge 影响。
- 尚缺模型语义提取、条件化偏好自动归并和真实 Claude 客户端 smoke。Codex 已有真实持久化与交互式 smoke，自动化注入断言使用单次 `--dangerously-bypass-hook-trust`，新进程仍可能需要用户在 `/hooks` 中信任 Hook。Trae 在非 macOS 平台当前仍需以前台 `watch` 或用户自己的进程管理器运行。

当前版本号表达的是共享记忆底座与首批三种 Adapter 的 Developer Preview 成熟度，不代表每个部署都必须启用全部组件。Lite 在 V1.1 仍保持单机、低成本和可离线运行。

## 8. 当前非目标

- 不承诺仅靠 MCP 自动获得 Agent 的完整对话；Trae/Codex Capture 依赖本机 app-server，Claude Capture 依赖公开 Stop transcript Hook。
- 不要求使用者修改第三方闭源 Agent 的源码。
- 不在个人版默认启用外部 embedding 或推理服务。
- 不为了展示技术而强制引入独立向量数据库、图数据库、消息队列或微服务。
- 不让自动推断的记忆绕过用户授权、scope 和审计。

接入是否会在每轮主动调用工具，仍取决于 Agent 产品的 MCP 支持和工具调用策略；OpenContinuity 负责把已发生的调用做成可靠、统一和可追溯的记忆行为。
