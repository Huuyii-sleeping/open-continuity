# OpenContinuity

OpenContinuity 是一个 local-first、用户可控的跨 Agent 共享记忆与任务交接层。它通过 MCP 或 HTTP 让不同 Agent 在同一用户身份和明确 scope 下读写同一事实层，并保留来源、版本、权限与审计历史。

当前发布候选为 `1.1.0-beta.1`，定位是 Developer Preview：Lite 本地闭环已可验证，Team 是实现预览，Enterprise 尚未实现。

```mermaid
flowchart LR
  subgraph C[Agent clients]
    A[Agent A]
    B[Agent B]
    D[Agent C]
  end

  subgraph O[OpenContinuity]
    X[MCP / HTTP / CLI]
    P[Identity · scope · policy]
    W[Remember · evolve · audit]
    R[Recall · context · bounded query]
    H[Handoff Capsule]
  end

  subgraph S[Storage Profiles]
    L[Lite · SQLite]
    T[Team · PostgreSQL]
  end

  A & B & D --> X
  X --> P
  P --> W
  P --> R
  P --> H
  W --> L & T
  R --> L & T
  H --> L & T
```

## 为什么它不只是 RAG

RAG、全文检索和 Agentic Retrieval 解决“如何找到内容”；OpenContinuity 还解决：

- **谁的记忆**：稳定用户身份和独立 Agent 身份。
- **谁能看到**：user、task、agent scope 以及 private 策略。
- **如何演化**：版本、CAS、幂等写入、来源和不可变事件历史。
- **如何交接**：结构化 Handoff Capsule，而不是复制整段对话。
- **如何带走**：带校验摘要、与具体数据库解耦的 Memory Package。
- **如何撤销**：查看、审计、遗忘、备份和恢复由用户控制。

支持四类结构化记忆：`user_preference`、`user_fact`、`task_state` 和 `decision`。除 Agent 主动调用 MCP 外，实验性的 Trae Conversation Capture 还可以由后台 Capture Adapter 或显式同步读取 Trae 客户端已保存的可观测会话，先放入本地 Inbox，再提取待确认候选；只有用户显式批准的候选才会进入长期共享记忆。

## 当前可验证能力

| 能力 | 当前证据 |
| --- | --- |
| 跨 Agent 共享记忆与 Handoff | `open-continuity demo` 启动两个真实 MCP stdio 客户端进行隔离验证 |
| Lite 本地运行 | SQLite、FTS5、事务、审计历史、备份与恢复 |
| Agent 接入 | Trae 真实 MCP E2E 与 Conversation Capture；Claude Code 和 Codex 连接器自动化测试 |
| 可移植性 | Memory Package 校验、空目标导入和本地身份重绑定 |
| 发布质量 | macOS/Linux、Node.js 22/24 CI，完整测试、审计、打包和安装后冒烟 |

详细边界见[兼容性矩阵](./docs/compatibility.md)与[支持策略](./SUPPORT.md)。

## 5 分钟开始使用

运行环境要求 Node.js 22.13 或更高版本。正式发布后先安装到稳定路径，再连接客户端：

    npm install --global open-continuity
    open-continuity demo
    open-continuity setup trae --workspace "$PWD"
    open-continuity doctor trae --workspace "$PWD"

`connect` 会拒绝把临时 `npx` 缓存路径写入永久客户端配置；全局安装或项目内持久安装都可以。

`setup trae` 是推荐接入入口：它会在需要时完成本地初始化，核验 Trae app-server，连接 OpenContinuity MCP，把指定 workspace 加入 Injection allowlist，备份并安装 `UserPromptSubmit` Hook，再在 macOS 安装和启动用户级 Capture 服务。命令可重复执行；只有配置或安装路径变化时才会刷新 MCP/重载服务。非 macOS 环境会保留前台 `capture watch` 接入方式。随后运行 `doctor trae`，可以逐层检查 Capture、checkpoint、Hook、MCP 和本地数据库。Trae 不提供可脚本化的 Hook 信任状态，也不应被设置为全局免审批，因此仍需在 Trae `/hooks` 中确认 Hook，并在需要深度查询时按正常策略批准 OpenContinuity MCP 只读工具。

`demo` 是不修改真实配置的产品证明：它会启动两个使用不同 Agent 身份的真实 MCP stdio 进程，让 Agent A 向临时 SQLite 写入记忆并创建 Handoff Capsule，关闭 Agent A 后再由 Agent B 读取记忆和恢复交接，最后自动删除临时数据库。它不要求提前执行 `init`，也不会访问 `~/.open-continuity/memories.db`。

从源码体验：

    npm install
    npm run build
    node dist/src/cli.js demo
    node dist/src/cli.js init
    node dist/src/cli.js connect trae
    node dist/src/cli.js doctor

`init` 会生成一个本地用户身份并创建 `~/.open-continuity/memories.db`。不同连接器共享同一个用户身份，同时各自绑定固定 Agent 身份，因此模型不需要猜测 `userId` 或 `agentId`。`connect` 修改客户端配置前会建立备份；已有同名 MCP Server 时默认拒绝覆盖，只有显式传入 `--force` 才会替换。当前连接器支持 `trae`、`claude` 和 `codex`，详细验证状态见 [兼容性矩阵](./docs/compatibility.md)。

常用管理命令：

    open-continuity database check
    open-continuity database backup --output ./memories-backup.db
    open-continuity database restore ./memories-backup.db --yes
    open-continuity memories list
    open-continuity memories list --query "test runner"
    open-continuity memories show <memory-id>
    open-continuity memories history <memory-id>
    open-continuity memories forget <memory-id> --yes
    open-continuity export --output ./memory-package
    open-continuity import ./memory-package

Trae 对话候选流程：

    open-continuity capture doctor
    open-continuity capture sync --thread <trae-thread-id>
    open-continuity capture thread <trae-thread-id>
    open-continuity capture candidates
    open-continuity capture approve <candidate-id> --share
    open-continuity capture reject <candidate-id>
    open-continuity capture status
    open-continuity capture watch --once
    open-continuity capture watch --interval 5000
    open-continuity capture service install
    open-continuity capture service start
    open-continuity capture service status
    open-continuity capture service stop
    open-continuity capture service uninstall

Trae 每轮轻量记忆注入（实验性）：

    open-continuity injection enable "$PWD"
    open-continuity injection status --json
    open-continuity injection disable

如需拆开排障或手动管理，也可以使用上面的 Capture/Injection 子命令。`injection enable` 只会把当前 workspace 加入 OpenContinuity 自己的 allowlist；推荐由 `setup trae` 负责完整接入。启用后，在 Trae 用户级 `$TRAECLI_HOME/hooks.json`（没有设置时通常是 `$HOME/.trae/hooks.json`）增加下面的 `UserPromptSubmit` command hook；把命令中的路径替换成 `injection status --json` 返回的绝对路径：

    {
      "hooks": {
        "UserPromptSubmit": [
          {
            "hooks": [
              {
                "type": "command",
                "command": "node /absolute/path/to/open-continuity/dist/src/injection-hook.js",
                "timeout": 1
              }
            ]
          }
        ]
      }
    }

Hook 默认关闭，且只检索已批准、`public`、当前 workspace 可见的记忆；每次最多注入 8 条、800 token 估算预算，查询超过 200ms 或发生存储错误时 fail open，不阻塞 Agent。注入内容会明确标记为不可信参考数据。审计回执只保存 Prompt 的短 SHA-256 指纹，不保存 Prompt 原文，写入 `~/.open-continuity/injection-receipts.jsonl`。可以用 `injection install-hook` 自动备份并更新 Trae 用户级 `hooks.json`，再用 `injection check-hook` 检查，Trae 内用 `/hooks` 确认；`injection disable` 会立即停止注入，但不会删除已写入回执。`capture watch` 默认以前台可中断轮询方式读取 `updatedAt` 发生变化的 thread，`--once` 用于单轮验证。每个成功导入的 thread 都会在同一 SQLite 事务内推进 durable checkpoint，记录 thread 更新时间、最后 turn、最后 item 和 item 总数；导入失败时 Inbox 与 checkpoint 一起回滚。`capture status` 和 `doctor trae` 会公开水位与恢复健康状态。

恢复和删除操作必须显式添加 `--yes`。恢复会写入一个新的数据库文件并原子切换本地配置，旧数据库不被覆盖；此前连接的 Agent 需要执行 `open-continuity connect <agent> --force` 并重启客户端，才能使用新库。CLI 导出只包含当前本地用户的数据；导入只接受通过校验且目标数据库为空的 Memory Package，并将来源用户身份重新绑定到当前本地用户，不会静默合并或覆盖现有记忆。

## 源码开发

    npm install
    npm run typecheck
    npm test
    npm run build
    npm run dev
    npm run benchmark:lite -- --memories=1000 --iterations=20

HTTP 服务默认监听 http://127.0.0.1:8787。MCP Server 使用 stdio transport，适合配置到支持 MCP 的 Agent 中。默认使用 Node 内置 SQLite，数据保存到 `~/.open-continuity/memories.db`，无需安装独立数据库服务；团队部署可切换到 PostgreSQL。运行环境要求 Node.js 22.13 或更高版本。

准备 Developer Preview 时运行 `npm run release:check`；该命令会完成类型检查、完整测试、生产依赖审计、包内容检查，以及从真实 tarball 隔离安装后的双 Agent MCP 演示。性能基准说明见 [Lite benchmark](./docs/benchmarking.md)，外部发布步骤和权限边界见[发布检查清单](./docs/release-checklist.md)。版本变化记录在 [CHANGELOG](./CHANGELOG.md)。

直接启动 MCP：

    npm run build
    npm run start:mcp

以 Codex、Claude Code 等客户端为例，配置一个 MCP Server：

    {
      "mcpServers": {
        "open-continuity": {
          "command": "node",
            "args": ["/Users/you/personal/open-continuity/dist/src/server.js", "--mcp"],
          "env": {
            "OPEN_CONTINUITY_PROFILE": "lite",
            "OPEN_CONTINUITY_STORE": "sqlite",
            "OPEN_CONTINUITY_SQLITE_PATH": "/Users/you/.open-continuity/memories.db",
            "OPEN_CONTINUITY_USER_ID": "local-shared-user",
            "OPEN_CONTINUITY_AGENT_ID": "claude"
          }
        }
      }
    }

手动配置多个客户端时，必须保持 `OPEN_CONTINUITY_USER_ID` 相同，并为每个客户端设置不同的 `OPEN_CONTINUITY_AGENT_ID`。优先使用 CLI 连接器自动生成和管理这两个身份。

客户端接入后会发现九个工具：原有的 `memory_capabilities`、`memory_remember`、`memory_recall`、`memory_context`、`memory_query`、`memory_history`、`memory_forget`，以及 `memory_handoff_create` 和 `memory_handoff_resume`。`memory_capabilities` 用于发现当前 Profile 和可用能力；`memory_context` 用于一次检索后生成 Context Pack；`memory_query` 用于有预算的多步检索。Agent 是否主动调用这些工具仍由客户端/模型的工具策略决定；Conversation Capture 是独立的显式同步/watch 入口，不依赖模型主动调用 MCP。

## Trae Conversation Capture（实验性）

这个 Adapter 通过本机 Trae 客户端的 app-server 读取用户明确选择同步的已保存 thread。它能看到 app-server 暴露的用户消息、Agent commentary/最终回复、工具调用结果和 compact 标记，但不能获得隐藏思维链，也不代表能观测任何第三方 Agent。

同步后的原始可观测项保存在 `~/.open-continuity/capture.db`，与长期记忆库 `memories.db` 隔离。当前规则提取器只识别“请记住”“以后”“我偏好/希望”“我们决定”等显式中英文信号，并把结果标为 private、pending 候选；普通闲聊不会直接写入长期记忆。完整回合需要同时满足 Trae 状态为 completed、存在用户消息和最终回复；中断或不完整回合会降低候选置信度。

不指定 `--thread` 时，`capture sync --limit 10` 会同步最近的非临时 CLI thread；更谨慎的方式是始终指定 thread ID。重复同步是幂等的。列表同步支持分页，并通过 `--limit`（每页规模）和 `--max-threads` 控制单轮扫描规模；达到上限时会报告截断。`capture watch` 适合前台运行，macOS 用户也可以用 `setup trae` 一次性注册当前用户的 `launchd` 后台服务，再用 `doctor trae` 或 `capture status` 查看服务、checkpoint 与同步健康状态。服务 start/stop/uninstall 可重复执行，停止会二次确认 launchd service 已消失，配置变化会安全重载。同步过程带单实例锁、过期锁清理和有限重试，服务日志位于 `~/.open-continuity/capture-service.log` 与 `~/.open-continuity/capture-service.error.log`。`capture thread` 用于检查 Inbox 实际读取到的规范化内容。`capture approve` 默认写为 private 长期记忆；显式添加 `--share` 才写为默认可被已连接 Agent 召回的 public 共享记忆。`capture reject` 只更新候选状态。当前已具备规则型显式信号提取、敏感字段脱敏与候选阻断、Inbox 默认 7 天保留和自动清理；仍未实现模型语义提取、候选合并和冲突处理。

效果评测使用仓库内完全虚构的数据集：`npm run eval:golden` 是快速冒烟，`npm run eval:suite` 是正式多轮门禁，`npm run eval:quality` 是语义检索挑战集。正式套件包含 18 个 Capture、13 个 Injection、6 个治理场景，每个场景独立运行 5 轮，共 185 次断言；质量集额外覆盖高相似、近重复、冲突、排序和权限边界。另有 `test/trae-vertical.test.ts` 验证 Trae Capture→审核→轻量 Injection→MCP 深搜纵向链路，不读取真实历史对话。

## Handoff Capsule

用户明确说“交接一下”时，Agent 可以调用 `memory_handoff_create`，保存任务摘要、状态、关键决策、下一步、产物和阻塞项。另一个 Agent 通过 `memory_handoff_resume` 按 `taskId` 恢复最新的未过期交接包。交接包使用 task scope，不会混入其他任务，并可配置 `expiresAt`。它解决的是一次工作的可靠续接，不等同于永久用户画像。

## 隐私边界

- Lite 默认只在本机 SQLite 中保存数据，不调用外部 embedding 或生成模型。
- MCP 接入不会自动获得完整对话；实验性 Trae Capture 只读取 Trae app-server 可见内容，`capture watch` 通过本地轮询增量发现变化。
- Conversation Inbox 与长期记忆隔离；候选必须显式批准才进入长期记忆。Inbox 中的敏感文本会先脱敏，默认 7 天后清理；存在 pending 候选的 thread 会保留到候选被批准或拒绝。
- MCP Server 会向支持说明字段的客户端声明：不得保存凭据、秘密或完整对话。
- private 记忆默认无法读取；启用前需要显式调整运行时策略。
- 用户可以查看历史、删除记忆并导出完整事件链。

## Runtime Profile

推荐优先配置 Profile，而不是只配置存储：

    OPEN_CONTINUITY_PROFILE=lite

| Profile | 默认存储 | 每通道候选预算 | Context Pack 默认/最大预算 | 最多记忆数 | 当前状态 |
| --- | --- | --- | --- | --- | --- |
| Lite | SQLite | 50 | 1024 / 4096 tokens | 20 | 已实现 |
| Team | PostgreSQL | 100 | 4096 / 16384 tokens | 50 | 基础版本已实现 |
| Enterprise | 尚未固定 | 尚未固定 | 尚未固定 | 尚未固定 | 未实现，启动时明确报错 |

没有设置 `OPEN_CONTINUITY_PROFILE` 时会兼容旧配置：SQLite 或 JSON 自动推导为 Lite，PostgreSQL 自动推导为 Team。显式 Profile 与 Store 冲突时会拒绝启动，例如 `team + sqlite` 或 `lite + postgres`。JSON 只能作为 Lite 的 legacy compatibility mode。

Lite 启动示例：

    OPEN_CONTINUITY_PROFILE=lite npm run start

Team 启动示例：

    OPEN_CONTINUITY_PROFILE=team \
    OPEN_CONTINUITY_DATABASE_URL="$YOUR_POSTGRES_URL" \
    npm run start

HTTP 可通过 `GET /health` 和 `GET /v1/capabilities` 发现当前 Profile。MCP 客户端可调用 `memory_capabilities` 获取相同信息，包括存储类型、检索通道、候选预算、Context Pack 预算，以及 semantic、rerank、agentic、graph 是否可用。

Agentic Query 的默认/最大预算如下：

| Profile | 默认/最大步骤 | 默认/最大超时 | 最大子查询 | 历史事件预算 |
| --- | --- | --- | --- | --- |
| Lite | 3 / 4 | 1500 / 5000 ms | 3 | 50 |
| Team | 5 / 8 | 3000 / 10000 ms | 8 | 100 |

## 存储模式

Lite 默认使用单文件 SQLite：

    OPEN_CONTINUITY_STORE=sqlite
    OPEN_CONTINUITY_SQLITE_PATH=/Users/you/.open-continuity/memories.db

SQLite 启用 WAL、写入等待和事务，支持多个本机 Agent 进程共享；`query` 查询使用 FTS5 trigram 索引，两个字符以内的短查询回退为普通子串匹配。FTS 只是可重建索引，事实和历史仍保存在 `memories_current` 与 `memory_events` 两张表中。

需要显式创建或升级 SQLite schema 时可以运行：

    OPEN_CONTINUITY_SQLITE_PATH=/Users/you/.open-continuity/memories.db npm run db:migrate:sqlite

日常维护建议先停止或重启正在连接该数据库的 Agent 客户端：

    open-continuity database check
    open-continuity database backup --output ./memories-backup.db
    open-continuity database restore ./memories-backup.db --yes

`database check` 执行 SQLite 完整性检查并报告 schema 版本、当前记忆数和事件数。备份使用 SQLite `VACUUM INTO` 产生独立、一致的数据库文件。恢复会先完整校验来源，再写入一个全新文件并原子更新本地配置；原数据库保留为回滚点，避免覆盖正在被旧 Agent 进程使用的文件。恢复结果会列出需要 `connect --force` 后重启的 Agent，`doctor` 也会把仍指向旧数据库的连接标记为未就绪。

V0.4 JSON 模式继续作为显式兼容选项：

    OPEN_CONTINUITY_STORE=json
    OPEN_CONTINUITY_DATA_FILE=/Users/you/.open-continuity/memories.json

从旧 JSON ledger 迁移到一个空的 SQLite 数据库：

    npm run data:import-json -- \
      --input /Users/you/.open-continuity/memories.json \
      --database /Users/you/.open-continuity/memories.db

导出 SQLite 中的完整事件历史：

    npm run data:export-json -- \
      --database /Users/you/.open-continuity/memories.db \
      --output ./open-continuity-export.json

导入命令只接受 OpenContinuity 事件 ledger，且目标数据库必须为空，因此不会静默合并或覆盖已有记忆。V0.4 升级后默认存储由 JSON 改为 SQLite；已有用户应先执行上述显式迁移，原 JSON 文件不会被自动删除或修改。

PostgreSQL 模式：

    OPEN_CONTINUITY_STORE=postgres
    OPEN_CONTINUITY_DATABASE_URL="$YOUR_POSTGRES_URL"
    OPEN_CONTINUITY_AUTO_MIGRATE=true
    npm run start

运行时默认会在启动前执行幂等迁移，并使用 PostgreSQL advisory lock 避免多个 Agent 进程首次启动时并发建表。也可以单独执行：

    OPEN_CONTINUITY_DATABASE_URL="$YOUR_POSTGRES_URL" npm run db:migrate:postgres

PostgreSQL 使用两张核心表：

- `memories_current`：当前有效记忆，供 `memory_recall` 快速查询。
- `memory_events`：不可变事件历史，供 `memory_history` 审计查询。

当前 Team Profile 尚未启用 pgvector，语义向量检索属于下一阶段；V1.0 的 Context Pack 和 Agentic Query 仍使用确定性混合检索，不引入外部 embedding 或生成模型。

## 产品分层

OpenContinuity 使用同一套记忆协议和数据语义，提供三种部署 Profile；它们不是三套互不兼容的产品。

| Profile | 面向场景 | 正式存储 | 默认检索 | 状态 |
| --- | --- | --- | --- | --- |
| Lite | 个人、本地 Agent | SQLite | 精确匹配、结构化过滤、FTS5 全文检索 | V1.0 已实现 |
| Team | 团队、多 Agent、多进程 | PostgreSQL + 可选 pgvector | 精确/结构化/全文融合，后续可加向量与重排 | PostgreSQL 与基础混合检索已实现，向量待实现 |
| Enterprise | 企业、多租户与复杂知识关系 | PostgreSQL、对象存储、可选图存储 | 自适应查询规划、多路召回、图谱多跳与证据验证 | 远期计划 |

JSON 会继续作为演示、调试、兼容和导入导出格式，但不会作为个人版的长期正式存储。不同 Profile 共享 MCP/HTTP 契约、Memory 数据模型、scope/权限语义和事件历史，避免接入方随部署规模增长而重写集成。标准化的 Memory Package 仍是后续能力。

检索强度不只由数据量决定，还由问题复杂度、延迟预算、token 预算、隐私边界和计算成本决定。简单的偏好查询应直接命中结构化记忆；只有需要跨时间、跨实体或多跳证据的问题才进入 Agentic Retrieval。

详细架构边界、差异化能力和版本验收标准见 [架构与路线图](./docs/architecture-and-roadmap.md)。

## 查询契约

`memory_recall` 只返回当前有效记忆，不再携带全部事件历史。支持 `key`、`kind`、`scope`、`taskId`、`query` 过滤，以及 `limit` 和不透明 `cursor` 分页；默认 20 条，最多 100 条。

不传 `query` 时，响应保持 V0.5 的确定性结构化查询格式。传入 `query` 时，响应会额外包含检索回执：

    {
      "memories": [
        {
          "key": "response_style",
          "retrieval": {
            "score": 0.0327868852,
            "channels": ["exact", "full_text"],
            "ranks": { "exact": 1, "full_text": 1 }
          }
        }
      ],
      "nextCursor": null,
      "retrieval": {
        "mode": "hybrid",
        "channels": ["exact", "full_text"],
        "candidateCount": 1,
        "candidateLimit": 50
      }
    }

检索游标绑定完整查询条件，不能跨 query、用户、Agent 或 scope 复用；非法或错配游标会返回 `VALIDATION_ERROR`。回执中的 `channels` 只包含实际产生候选的通道；当前 RRF 的 `k=60`，分数用于稳定排序和解释，不代表概率或事实置信度。`candidateLimit` 是每个检索通道的候选预算，不是最终返回条数；最终返回条数仍由请求的 `limit` 控制。

    {
      "memories": [],
      "nextCursor": null
    }

## Context Pack 契约

`memory_context` 和 HTTP `POST /v1/context-pack` 在 `memory_recall` 之上完成面向消费 Agent 的二次选择。请求必须包含 `userId`、`agentId` 和非空 `query`，还可以指定 `taskId`、`purpose`、`tokenBudget` 与 `maxMemories`：

    {
      "userId": "u1",
      "agentId": "claude",
      "query": "open-continuity implementation",
      "taskId": "task-42",
      "purpose": "coding",
      "tokenBudget": 1024,
      "maxMemories": 10
    }

`purpose` 支持 `general`、`coding`、`research` 和 `browser`。Builder 先复用当前 Profile 的检索管线，再综合检索分数、task/agent scope、用户确认状态和 purpose 对 memory kind 的偏好进行稳定排序。响应包含：

- `context`：逐行 JSON，可直接作为一段结构化上下文注入 Agent。
- `items`：入选记忆、估算 token、排序分数和选择原因。
- `omitted`：因 `token_budget` 或 `max_memories` 未进入上下文的完整记忆引用。
- `budget`：请求预算、实际使用、剩余预算和估算方法。
- `retrieval`：底层混合检索的通道和候选回执。

V0.8 使用确定性的 `utf8_bytes_v1` 估算，即 UTF-8 字节数除以 4 后向上取整。它不是特定模型 tokenizer 的精确计数。为避免改变事实语义，单条记忆放不下时会整条省略，不会截断或调用模型压缩；调用方可从 `omitted` 看到原因。Context Pack 继续遵守原有 user/task/agent scope 和 private 策略，不会扩大底层检索权限。

## Agentic Query 契约

`memory_query` 和 HTTP `POST /v1/query` 是独立于 `memory_recall` 的增强查询入口。调用方可以只提供自然语言查询，也可以显式提供更可靠的 `subqueries`：

    {
      "userId": "u1",
      "agentId": "claude",
      "query": "项目技术决策的演化",
      "strategy": "multi_step",
      "subqueries": ["TypeScript", "Vitest"],
      "includeHistory": true,
      "maxSteps": 3,
      "timeoutMs": 1000,
      "minEvidence": 2
    }

响应包含 `plan`、逐步 `steps`、去重融合后的 `evidence`、可直接消费的 `contextPack`、`sufficiency`、实际执行预算以及 `fallback`。复杂度分为 L0-L3：L0 是显式 key，L1 是单次混合检索，L2 是多子查询或历史扩展；L3 表示需要关系或语义多跳，V1.0 只做尽力召回并返回 `unsupported_complexity`，不会声称已经完成图谱推理。

规划器是 `deterministic_v1`。显式 `subqueries` 最可靠；自动拆分只识别有限的中英文连接词。`direct` 强制只执行一次 recall，不能与 `includeHistory=true` 同用。显式子查询超过当前 Profile 上限会返回 `VALIDATION_ERROR`，自动拆分超限会截断并返回 `subquery_limit`。历史扩展按排名靠前的候选 memoryId 定向读取，最多展开 `maxSubqueries` 个候选，并共享当前 Profile 的历史事件预算；发生截断时会标记 `history_limit` 和 `history.truncated=true`。整体超时基于 `Promise.race`：结果会停止等待并确定性降级，但底层只读数据库调用无法被强制取消，其迟到结果会被忽略。

`sufficiency.status` 的语义是：`sufficient` 表示查询覆盖、最小证据、历史要求和执行预算全部满足；有部分证据时为 `partial`；完全没有证据时为 `insufficient`。无论走几步，scope、task、Agent 私有范围和 private 策略都不会被放宽。

## 记忆演化契约

`memory_remember` 和 HTTP `POST /v1/memories` 继续兼容 V0.8 请求；不传演化字段时仍采用 `replace + last_write_wins`。需要防止多个 Agent 基于旧状态互相覆盖时，可以传 `expectedVersion`：

    {
      "userId": "u1",
      "agentId": "claude",
      "key": "coding_preferences",
      "value": { "formatting": { "quotes": "single" } },
      "kind": "user_preference",
      "writeMode": "merge",
      "expectedVersion": 1,
      "confidence": 0.8,
      "confidenceBasis": "source_supported",
      "idempotencyKey": "update-42"
    }

- `expectedVersion=0` 表示仅当该逻辑 key 尚不存在时创建；大于 0 时要求当前版本完全匹配，否则返回 HTTP 409 / `VERSION_CONFLICT`。
- `writeMode=replace` 整体替换值；`writeMode=merge` 只接受 JSON 对象并确定性深度归并。数组和标量不会智能合并。
- 成功回执的 `evolution` 包含 `created/replaced/merged`、新版本、并发模式及 `supersedes`。
- `confidence` 必须与 `confidenceBasis` 一起提交；依据可以是 `user_asserted`、`agent_inferred` 或 `source_supported`。`user_asserted` 还要求 `userConfirmed=true`。系统不会自行生成一个看似精确的置信度。
- 当前记忆、历史事件和 Context Pack 都会保留 `version`、`supersedes` 与 `confidence`。历史事件同时记录归并前的输入补丁和归并后的最终值。

V0.9 的 `merge` 是可复现的数据操作，不是模型自动解决语义冲突。例如“默认喜欢详细解释”和“编码时喜欢简短回答”仍应由调用方写成不同 scope/key 或条件化对象；自动冲突判断、语义归并和归并撤销仍属于后续能力。

审计历史通过 `memory_history` 或 HTTP `GET /v1/memory-events` 单独查询：

    {
      "events": [],
      "nextCursor": null
    }

scope 语义如下：

- `user`：同一用户的不同 Agent 都可读取。
- `task`：写入时必须指定 `taskId`，读取和删除时必须进入相同任务。
- `agent`：只对创建该记忆的 Agent 可见。

## 本地安全配置

默认不配置 API Key，保持本地开发的零配置体验。需要限制 HTTP 调用方时，在环境变量中设置：

    OPEN_CONTINUITY_API_KEY=replace-with-a-local-secret
    OPEN_CONTINUITY_ALLOWED_AGENTS=codex,claude,glm
    OPEN_CONTINUITY_ALLOW_PRIVATE=false

HTTP 请求可以使用以下任一方式携带 API Key：

    x-open-continuity-api-key: replace-with-a-local-secret
    Authorization: Bearer replace-with-a-local-secret

当配置 Agent 白名单后，`agentId` 不在白名单中的请求会返回 403。private 记忆默认不能通过接口读取；只有明确设置 `OPEN_CONTINUITY_ALLOW_PRIVATE=true` 后，调用方传 `includePrivate=true` 才会返回。

HTTP 和 MCP 错误都遵循统一结构：

    {
      "error": {
        "code": "VALIDATION_ERROR",
        "message": "Request validation failed",
        "details": []
      }
    }

测试中的 MemoryService 默认使用内存存储；HTTP/MCP 运行时通过 `OPEN_CONTINUITY_STORE` 选择 SQLite、JSON 或 PostgreSQL。SQLite 是个人版默认模式；JSON ledger 保留文件锁与原子替换以兼容 V0.4；PostgreSQL 使用事务、唯一约束和索引，适合多进程和后续多实例部署。语义 planner、pgvector、图遍历、Outbox、OAuth、多租户和完整 Handoff 放在后续版本。
