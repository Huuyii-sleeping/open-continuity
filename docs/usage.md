# OpenContinuity 使用指南

本指南面向当前源码版 Developer Preview，集中说明配置、客户端连接、记忆管理与集成契约。初次使用从 [README](../README.md#快速开始) 开始；任务交接的完整示例见[交接指南](./handoff-workflow.md)。

- [源码运行与本地配置](#源码运行与本地配置)
- [连接与客户端边界](#连接与客户端边界)
- [候选审核与轻量注入](#候选审核与轻量注入)
- [记忆管理与备份](#记忆管理与备份)
- [Runtime Profile 与存储](#runtime-profile-与存储)
- [MCP 与 HTTP 集成](#mcp-与-http-集成)
- [检索、上下文与更新契约](#检索上下文与更新契约)
- [数据保留与安全配置](#数据保留与安全配置)

## 源码运行与本地配置

需要 Node.js 22.13+ 和 npm，使用仓库锁文件安装：

```bash
npm ci
npm run build
node dist/src/cli.js demo
```

本指南的 `node dist/src/cli.js` 命令均在仓库根目录执行。也可以在构建后执行 `npm link`，将当前源码版连接为全局 `open-continuity` 命令；这使用本机 npm 全局安装路径。连接 Agent 后保留稳定的 checkout/安装位置，移动或重建安装路径后重新运行 setup/doctor。

`demo` 运行两个 MCP 协议客户端和临时 SQLite，完成虚构记忆写入、进程重启后的召回及旧兼容 Handoff 创建/恢复。它不初始化真实配置，不读取真实历史，并自动清理数据库。审核交接流程由独立的 prepare/confirm 测试和安装包 smoke 验证；这些工程检查与真实模型任务效果分开。

```bash
node dist/src/cli.js init
node dist/src/cli.js help
```

`init` 创建稳定的本地 `userId`、配置和长期 SQLite。默认目录为 `~/.open-continuity/`，使用 `OPEN_CONTINUITY_HOME` 可选择独立的 CLI 数据目录。不同客户端连接器共享这个用户身份，各自绑定 Agent 身份。

| 文件 | 用途 |
| --- | --- |
| `config.json` | CLI 配置、用户身份、已连接客户端及各 Adapter allowlist |
| `memories.db` | 长期记忆与事件历史 |
| `capture.db` | 短期 Conversation Inbox、候选与 checkpoint |
| `injection-receipts.jsonl` | 轻量注入的元数据回执 |

直接启动服务时，数据库路径由 `OPEN_CONTINUITY_SQLITE_PATH` 等运行时变量决定；CLI 的 `OPEN_CONTINUITY_HOME` 和服务的数据库变量不能混为同一个开关。连接器会把 CLI 当前数据库路径传入生成的 MCP 配置。

## 连接与客户端边界

先替换示例 workspace 路径，只允许需要使用记忆的项目：

```bash
node dist/src/cli.js setup codex --workspace /absolute/path/to/your-project
node dist/src/cli.js doctor codex --workspace /absolute/path/to/your-project
```

Claude Code 与 Trae 使用相同形式，将 `codex` 替换为 `claude` 或 `trae`。setup 初始化本地配置，备份客户端设置，连接 MCP 并安装相应 Hooks，配置该客户端独立的 Capture/Injection allowlist。重复安装幂等，步骤失败时补偿回滚本轮变更。

| 客户端 | Capture | Injection | 安装后操作 |
| --- | --- | --- | --- |
| Trae | 本机 app-server，可显式 sync/watch | `UserPromptSubmit` Hook | 检查 `/hooks` 信任及 MCP 审批；macOS setup 可管理用户级 launchd Capture 服务 |
| Claude Code | `Stop` Hook 提供的 transcript | `UserPromptSubmit` Hook | 重启会话，重新加载设置并保留正常审批 |
| Codex CLI | 本机 `app-server --stdio`，`Stop` 触发同步 | `UserPromptSubmit` Hook | 重启会话，在 `/hooks` 检查并信任已安装处理器 |

这些入口只能读取公开扩展面暴露的内容。客户端及版本的实际验证程度见[兼容性矩阵](./compatibility.md)，不能把协议测试、只读探针或工具可用当成真实模型完成任务。

只需要 MCP 时：

```bash
node dist/src/cli.js connect codex
node dist/src/cli.js doctor
```

`connect` 修改前备份配置；已有同名 MCP Server 时默认拒绝覆盖。确认需要更新已有连接时，显式使用 `--force`。Codex app-server 不可用时可以采用 MCP-only，此时不能声明已有 Capture 支持。连接器拒绝将临时 npx 缓存路径写为永久服务路径。

断开 MCP 连接与卸载 Hook 是不同操作。`disconnect <agent>` 断开该连接；`injection uninstall-hook --agent <agent>` 只移除记录为 OpenContinuity 所有的处理器。Claude/Codex 的 Stop Hook 会随对应卸载移除并禁用 Capture，不删除用户自己安装的处理器。

## 候选审核与轻量注入

各客户端 Capture/Injection 的启用与 workspace allowlist 独立保存。setup 只授权指定 workspace；Claude/Codex 通过 Stop 事件产生候选，Trae 可使用显式同步或 watch。

```bash
node dist/src/cli.js capture candidates
node dist/src/cli.js capture status --source codex
node dist/src/cli.js capture thread "<thread-id>" --source codex
```

核对候选内容、来源和 scope，再替换 ID 执行需要的操作：

```bash
node dist/src/cli.js capture approve "<candidate-id>"
node dist/src/cli.js capture approve "<candidate-id>" --share
node dist/src/cli.js capture reject "<candidate-id>"
```

上述是替代操作：普通批准默认 private；认可并允许其它 Agent 召回时选择 `--share`。候选与现有记忆高度相似但不相同时，只给审核提示；需要替换时显式加 `--replace-memory "<memory-id>"`，生成可审计的新版本。完全相同的候选可合并 evidence，不能把语义相似当作已经确认同一个事实。

Trae 的按线程同步与前台轮询：

```bash
node dist/src/cli.js capture sync --source trae --thread "<thread-id>"
node dist/src/cli.js capture watch --once
node dist/src/cli.js capture watch --interval 5000
```

`capture watch` 是 Trae 前台入口，可中断；不把它当成 Claude/Codex 的通用 watcher。不指定线程时，分页规模和单轮线程上限会限制同步，截断状态可从回执查看。同步幂等，导入与 checkpoint 在同一事务内推进，失败不推进水位。

macOS Trae 后台服务由 `setup trae` 管理，也可用 `capture service status|start|stop|uninstall` 查看和管理；其它环境使用前台 watch。服务日志位于本地数据目录，报告问题前检查是否含个人或环境信息。

```bash
node dist/src/cli.js injection status --agent codex
node dist/src/cli.js injection check-hook --agent codex
```

轻量 Injection 仅使用已批准、public、当前 workspace 可见的记忆。默认上限为 8 条、800 token 估算预算和 200ms 查询等待，异常时 fail open。token 为 UTF-8 字节估算，不能当成具体模型 tokenizer 的精确计数；注入内容标为参考数据。

分开控制入口与出口时，使用 `capture enable <workspace> --source <agent>` / `injection enable <workspace> --agent <agent>` 及对应 disable。配置迁移保留备份，不向其它 Adapter 自动广播 workspace 权限。

## 记忆管理与备份

```bash
node dist/src/cli.js memories list
node dist/src/cli.js memories list --query "response_style"
node dist/src/cli.js memories show "<memory-id>"
node dist/src/cli.js memories history "<memory-id>"
```

个人 CLI 管理入口支持 `--private` 查看当前用户私有记忆；HTTP/MCP 的 private 请求还受运行时策略约束。遗忘需要明确确认：

```bash
node dist/src/cli.js memories forget "<memory-id>" --yes
node dist/src/cli.js database check
node dist/src/cli.js database backup --output ./memories-backup.db
```

恢复前先检查来源与备份。它写入一个新数据库并切换 CLI 配置，保留旧数据库用于回滚，不覆盖正在被旧进程使用的文件：

```bash
node dist/src/cli.js database restore ./memories-backup.db --yes
```

恢复后按命令提示更新各连接并重启 Agent；旧 MCP 进程仍可能指向原数据库。`doctor` 可检查路径是否一致。升级 Schema 5 后，旧评分游标需要从第一页重启；旧运行时不应打开新 schema，见[迁移说明](./compatibility.md#sqlite-literal-value-index--schema-5)。

Memory Package 与数据库备份是不同格式：

```bash
node dist/src/cli.js export --output ./memory-package
node dist/src/cli.js import ./memory-package
```

CLI 导出只包含当前本地用户的数据；导入核对校验摘要，将身份重新绑定到本地用户，并要求目标事件库为空。它不静默合并现有记忆。旧 JSON 事件 ledger 的整库迁移/导出脚本为 `data:import-json` / `data:export-json`，不是上述用户限定的 Memory Package；维护时需明确处理范围。

## Runtime Profile 与存储

| Profile | 存储和检索 | 定位 |
| --- | --- | --- |
| `lite` | SQLite/FTS5，真实 BM25 排名和短查询字面 fallback | 当前主要验证路径 |
| `team` | PostgreSQL，结构化读取及 substring fallback | 实现预览，需独立部署验收；无内置 Dense/pgvector 能力 |
| `enterprise` | 尚未实现 | 启动时明确拒绝 |

JSON 是 Lite 旧数据兼容/迁移路径。未指定 Profile 时，SQLite/JSON 推导为 Lite，PostgreSQL 推导为 Team；显式配置冲突会拒绝启动。详细预算及语义边界见[架构](./architecture-and-roadmap.md)与[兼容性](./compatibility.md)。

在新的虚构数据目录中运行 Lite 服务：

```bash
OPEN_CONTINUITY_PROFILE=lite \
OPEN_CONTINUITY_SQLITE_PATH=/absolute/path/to/fictional/memories.db \
npm run start
```

需要显式迁移 SQLite 时使用 `npm run db:migrate:sqlite` 并指定同一数据库路径。数据库启用 WAL、事务和等待策略，FTS 是可重建索引，记忆与事件才是权威源。

Team 使用已有 PostgreSQL 服务，在本地环境提供连接串：

```bash
OPEN_CONTINUITY_PROFILE=team \
OPEN_CONTINUITY_DATABASE_URL="$YOUR_POSTGRES_URL" \
npm run start
```

运行时默认执行幂等迁移，`OPEN_CONTINUITY_AUTO_MIGRATE=false` 可关闭自动迁移；显式迁移使用 `npm run db:migrate:postgres`。不要把实际连接串或凭据写进仓库/问题报告。

SQLite 的 Embedding/Dense、模型重排与支持验证为显式 Core 实验，默认服务工厂不装配模型，没有普通用户语义开关或自动安装。设计与限制见[接入](./retrieval-core/embedding-integration.md)及[模型验收](./retrieval-core/relevance-reranking-validation.md)。

## MCP 与 HTTP 集成

### MCP stdio

```bash
npm run start:mcp
```

对于支持自定义 MCP 的其它客户端，按该客户端的配置格式注册服务。以下是常见 `mcpServers` 形式，替换为实际稳定的绝对路径：

```json
{
  "mcpServers": {
    "open-continuity": {
      "command": "node",
      "args": ["/absolute/path/to/open-continuity/dist/src/server.js", "--mcp"],
      "env": {
        "OPEN_CONTINUITY_PROFILE": "lite",
        "OPEN_CONTINUITY_SQLITE_PATH": "/absolute/path/to/fictional/memories.db",
        "OPEN_CONTINUITY_USER_ID": "fictional-shared-user",
        "OPEN_CONTINUITY_AGENT_ID": "fictional-agent-a"
      }
    }
  }
}
```

多个客户端需共享同一数据库与 `userId`，分别设置 `agentId`。配置的身份会由 MCP 运行时绑定，调用参数不能覆盖它。服务启动不是客户端安装步骤；标准 Trae/Claude/Codex 优先使用 setup/connect。

共 11 个工具及其职责见 [README](../README.md#mcp-与-http)。准备交接后必须展示草稿并等待明确确认，再调用 confirm；旧 `memory_handoff_create` 是直接写入兼容入口。

### HTTP

`npm run start` 默认使用 `127.0.0.1:8787`；通过 `HOST` / `PORT` 调整监听。检查服务：

```bash
curl http://127.0.0.1:8787/health
curl http://127.0.0.1:8787/v1/capabilities
```

| 方法与路径 | 用途 |
| --- | --- |
| `POST /v1/memories` / `GET /v1/memories` | 写入 / 检索当前记忆 |
| `POST /v1/context-pack` / `POST /v1/query` | Context / 多步 Query |
| `GET /v1/memory-events` / `GET /v1/memories/:memoryId/history` | 独立历史查询 |
| `DELETE /v1/memories/:memoryId` | 遗忘记忆 |
| `POST /v1/handoffs/prepare` / `POST /v1/handoffs/confirm` | 准备 / 确认交接 |
| `GET /v1/handoffs/:taskId` | 恢复交接 |
| `POST /v1/handoffs` | 旧直接创建交接入口 |

HTTP 请求显式传入可信调用方的 `userId` / `agentId`。API key 和 Agent allowlist 的配置见本指南最后一节；当前不是跨用户登录认证服务。

## 检索、上下文与更新契约

### Recall、Context、Query

| 入口 | 输入与结果 |
| --- | --- |
| Recall | 按 `key/kind/scope/taskId/query` 检索当前有效记忆；`limit/cursor` 分页，不携带全量历史 |
| Context | 在检索结果上按相关性、用途同分规则和数量/token 预算选择完整记忆，返回选择、省略、预算和检索回执 |
| Query | 有预算地执行显式子查询或有限确定性拆分，支持定向历史扩展，返回步骤、证据、Context、充分性及原值引用 |

Context 请求示例（虚构身份）：

```json
{
  "userId": "fictional-shared-user",
  "agentId": "fictional-agent-b",
  "query": "response_style",
  "purpose": "general",
  "tokenBudget": 1024,
  "maxMemories": 8
}
```

Recall 默认 `limit=20`、最大100；评分回执区分通道、原始分数、排名和融合贡献，分数不是概率或事实置信度。候选预算不等于最终返回数量。游标绑定完整查询、身份与有效策略；查询或模型/索引策略变化后重新从第一页开始。

Context 的 purpose 支持 `general/coding/research/browser`。scope、private 和确认属于资格边界，不冒充相关性加分。token 使用 `utf8_bytes_v1` 估算，放不下的记忆整条省略，不截断事实或用模型压缩。

Query 可以使用显式 `subqueries`；默认 planner 为确定性实现，不会自动调用模型改写。`direct` 不与历史扩展同时使用；超出 Profile 的显式预算会拒绝，自动拆分截断会在回执中标明。复杂关系/语义多跳仍为不支持或部分结果。

`sufficiency` 根据实际 Context 判断字面覆盖和执行契约，不证明语义答案正确；原召回口径保留在 `retrievalSufficiency`。`answer` 是带 memory/event/version/内容指纹的原值投影，可能为 `evidence_ready/partial/abstain`，没有自由文本语义综合或历史时间线。

### 记忆范围与更新

| scope | 可见范围 |
| --- | --- |
| `user` | 同一用户的不同 Agent |
| `task` | 同一用户与明确的 `taskId` |
| `agent` | 同一用户及来源 Agent |

private 默认不参与接口召回；普通 Recall 与 Context/Query 消费者的确认策略分别保留，不能把所有入口都描述为仅返回已批准记录。Injection 与 Dense 使用已批准的可见内容。

写入至少提供身份、`key/value/kind/idempotencyKey`。记忆 kind 为 `user_preference/user_fact/task_state/decision`。需要防止覆盖旧状态时用 `expectedVersion`：0 表示仅创建，大于0要求当前版本匹配，冲突返回409 / `VERSION_CONFLICT`。

`writeMode=replace` 替换整个值，`merge` 对 JSON 对象做确定性深度归并，不自动理解语义冲突。`confidence` 与 `confidenceBasis` 成对提供，`user_asserted` 还需 `userConfirmed=true`；不提供时内核不自行生成置信度。

显式事实声明需要用户确认和版本条件，复用同 scope 的事实组/有效期/精确替代引用；缺引用、冲突或预算不足时返回核实状态。更新与来源事件、版本、历史共同记录。协议版本和迁移详情见[兼容性说明](./compatibility.md)。

## 数据保留与安全配置

| 数据 | 默认保留 |
| --- | --- |
| 原始 Inbox 回合 | 7 天 |
| 待审核候选 evidence | 30 天，不延长原始回合保留 |
| Injection 回执 | 30 天且最多5000条，保存短指纹而非 Prompt 原文 |
| 长期记忆 | 用户显式管理，独立于瞬时数据清理 |

```bash
node dist/src/cli.js data status
node dist/src/cli.js data cleanup
node dist/src/cli.js data purge-transient --yes
```

purge 清理 Inbox、候选、checkpoint 和回执，保留已批准长期记忆。仍启用 Capture 时，新的 Agent 活动会产生新的短期数据；需要停止观察时先禁用对应 Capture。

服务可设置 `OPEN_CONTINUITY_API_KEY`，HTTP 使用 `x-open-continuity-api-key` 或 `Authorization: Bearer ...`；`OPEN_CONTINUITY_ALLOWED_AGENTS` 是逗号分隔白名单。`OPEN_CONTINUITY_ALLOW_PRIVATE` 默认 false，HTTP/MCP 读取 private 还需显式请求 `includePrivate=true`。

错误返回统一的 `error.code/message/details`。超时、容量忙碌、无命中和存储失败分别表达；Query 可以返回 timeout/abstain。截止时间会停止等待与后续调度，已经发出的底层 SQL 不保证硬取消，实际未完成工作仍受容量与 drain 管理。

本地文件尽可能使用 owner-only 权限，这不等于加密。当前依赖可信调用方身份和真实传达的批准，不提供多租户身份认证；外部网络访问需单独检查 API key、网络和权限。第三方 Agent 可能将收到的上下文发送到其配置的模型服务。

不要保存凭据或将真实对话/导出/日志附到公开问题。支持、漏洞报告及完整安全边界见 [SUPPORT](../SUPPORT.md) 和 [SECURITY](../SECURITY.md)。
