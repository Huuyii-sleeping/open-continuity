# OpenContinuity 项目协作规则

本文件只记录 OpenContinuity 的项目专属约定。必须同时遵守 `~/personal/AGENTS.md`；两者冲突时，以更严格的个人隐私、来源、提交和推送规则为准。

## 1. 项目定位与当前边界

- OpenContinuity 的核心身份是 **local-first、用户可控的跨 Agent 共享记忆与任务交接层**。
- 当前主线是把共享记忆接入 Agent 的真实对话闭环：`Capture Adapter -> 本地 Inbox -> 脱敏/候选审核 -> 长期记忆 -> Injection Adapter / MCP 深度查询`。
- Capture 和 Injection 是共享记忆的适配入口/出口，不是独立的聊天记录产品，也不是把所有对话直接建成向量库。
- 默认只在用户自己的电脑上运行，不主动上传云端，不修改第三方 Agent 源码，不把完整对话自动沉淀为长期记忆。
- MCP 负责记忆能力发现、按需检索、深度查询和 Handoff；Agent 是否主动调用 MCP 由客户端和模型工具策略决定，工具可用不等于一定会被调用。
- MCP 本身不能保证获得第三方 Agent 的完整历史；只有对应 Capture Adapter 能从该 Agent 的公开扩展面读取可观测内容时，才可进入本地 Inbox。
- 未经真实环境、版本和测试证据验证，不要对外声称“支持某个 Agent”或“能看到该 Agent 的全部对话”。

## 2. 数据流与数据分层

标准链路如下，新增能力应保持职责边界清晰：

```text
Agent 对话
  -> Capture Adapter（公开扩展面）
  -> Conversation Inbox（短期、可脱敏、可过期）
  -> 候选提取与用户审核
  -> 长期共享记忆（结构化、版本化、可审计）
  -> Injection Adapter（下一轮轻量上下文）
  -> MCP（按需深度检索或任务交接）
```

- 原始可观测对话、候选证据、长期记忆、Injection 回执是不同生命周期的数据，不能混用同一套保留策略。
- 默认原始 Inbox 回合保留 7 天；待审核候选证据默认保留 30 天；Injection 回执默认保留 30 天且最多 5000 条。修改默认值必须同步 CLI、测试和文档。
- 同步必须增量化：使用 thread/turn/item checkpoint、`updatedAt` 和幂等约束；重复同步不得重复生成长期记忆或 occurrence。
- 导入失败时不得推进 checkpoint；数据库写入和 checkpoint 更新应保持同一事务边界。
- 候选默认是 `pending`，只有用户显式批准才能进入长期记忆；`--share` 才允许写成默认可被其他 Agent 召回的 `public` 记忆。
- 相同候选可以合并 evidence；高相似但内容不同的候选只能产生审核提示，替换必须显式指定目标并形成可审计的新版本。
- 数据治理命令（cleanup、purge、forget、restore）必须有明确的确认边界；删除或恢复后要验证长期记忆、审计历史和临时数据的预期保留关系。

## 3. Runtime Profile 与存储

Profile 是容量、查询策略和部署边界，不是简单的数据库开关：

| Profile | 当前定位 | 默认存储 | 当前状态 |
| --- | --- | --- | --- |
| `lite` | 个人本地运行 | SQLite/FTS5 | 当前主要可验证路径 |
| `team` | 团队共享服务 | PostgreSQL | 实现预览，需独立环境验证 |
| `enterprise` | 企业治理 | 未定 | 尚未实现，不能伪称可用 |

- `OPEN_CONTINUITY_PROFILE` 支持 `lite`、`team`、`enterprise`；`OPEN_CONTINUITY_STORE` 支持 `sqlite`、`postgres` 和兼容旧数据的 `json`。
- Lite 不使用 PostgreSQL；Team 必须使用 PostgreSQL；Enterprise 当前应明确返回未实现错误。
- JSON 是兼容/迁移路径，不要继续把新功能建立在 JSON 全量扫描上。
- 本地版本暂不做云端多租户；稳定本地 `userId`、Agent 身份、workspace allowlist 和 memory scope 仍必须保留。
- 默认长期数据库位于 `~/.open-continuity/memories.db`，Capture Inbox 使用独立的 `capture.db`；真实数据库、日志、回执、备份和配置不得进入仓库。
- Lite 当前是确定性混合检索（exact/structured/full-text）和有预算的确定性 Agentic Query；尚未实现向量 embedding、semantic reranker、自动语义归并或图谱遍历。代码和文档不得把 roadmap 能力写成已实现能力。

## 4. Adapter 契约与客户端边界

公共契约位于 `src/adapters/contracts.ts`，不得让单个 Agent 的协议细节泄漏到核心记忆层：

- `CaptureAdapter` 必须实现 `connect`、`listThreads`、`readThread`、`close`，返回统一的 thread/turn/item 模型，并保证 source、workspace 和完成状态可校验。
- `InjectionAdapter` 必须实现 `check`、`install`、`emptyOutput`、`renderContext`，安装应幂等、先备份、不得覆盖用户已有配置。
- 所有 Capture Adapter 都必须支持 workspace allowlist、跳过 ephemeral 内容、增量 checkpoint、有限重试和失败可恢复状态。
- 所有 Injection Adapter 都只能注入已批准、`public`、当前 workspace 可见的少量记忆；必须有 token/数量/延迟预算，超时或存储异常应 fail open，不阻塞 Agent。
- Injection 回执只保存短 Prompt 指纹、memory id、原因、耗时和结果，不保存 Prompt 原文。

当前适配边界：

- Trae：通过本机 app-server 读取可观测 thread；macOS 可由 `setup trae` 管理用户级 launchd 服务，其他环境使用前台 `capture watch`；Hook 信任和 MCP 审批仍需用户在 Trae 中确认。
- Claude Code：使用公开的 `Stop` transcript Capture 和 `UserPromptSubmit` Injection Hook；安装后需要重启会话；没有真实客户端环境证据时，只能描述为协议/黑盒验证，不得声称真实客户端完全验证。
- Codex CLI：使用本地 `app-server --stdio` 和 `$CODEX_HOME/hooks.json` 的 `Stop`/`UserPromptSubmit` Hook；安装后需要重启并在 `/hooks` 中信任；app-server 不可用时只能退化为 MCP-only，不得伪造 Capture 支持。
- 其他 Agent：只要支持自定义 MCP Server，可使用共享记忆/MCP；只有存在可观测 Capture 或 Injection 扩展面时，才新增对应 Adapter。
- 不为适配而修改第三方 Agent 源码，不依赖隐藏接口或隐藏思维链；reasoning 内容不得持久化。

新增或修改 Adapter 时，必须同时更新：

1. 统一契约和失败边界；
2. 该客户端的 setup/doctor/connect 配置与备份逻辑；
3. 正常、重复执行、错误、workspace 拒绝、超时和重启场景测试；
4. `docs/compatibility.md`、README 或 CHANGELOG 中的实际验证范围。

## 5. 代码组织与实现原则

- `src/core/` 维护记忆、检索、Context Pack、Agentic Query、演化和 scope 规则；不要在这里读取某个 CLI 的原始 transcript。
- `src/capture/` 维护规范化对话、Inbox、checkpoint、候选和数据治理；`src/injection/` 维护 Hook 输出、预算、回执和客户端 Hook 配置。
- `src/cli/` 维护用户配置、连接器、setup/doctor 和可操作 CLI；安装器必须保留并备份用户原配置，重复执行应幂等。
- `src/sqlite/`、`src/postgres/` 负责存储实现和迁移；修改 schema、scope、身份、版本、Memory Package 或 Handoff Capsule 都属于协议/迁移变更。
- 优先使用现有类型、错误码、事务、CAS、幂等键和审计事件；不要用字符串拼接、全量扫描或静默覆盖绕过既有一致性边界。
- 运行时路径、临时数据库和测试夹具必须由测试显式注入；不要读用户默认 `HOME` 下的真实 Agent 历史来完成单元测试。
- 新增日志不得输出 Prompt、transcript 原文、tool input/output、真实路径或凭据；必要时只记录脱敏后的计数、字段名、短摘要或指纹。

## 6. 测试与验收分层

Node.js 要求 `22.13+`，使用 npm 和仓库锁文件。常用命令：

```bash
npm ci
npm run typecheck
npm test
npm run build
npm run test:soak
npm run eval:golden
npm run eval:suite
npm run eval:quality
npm run release:check
```

- 快速开发至少运行 `npm run typecheck` 和受影响测试；代码、schema、Adapter 或数据治理变更应补对应测试。
- `test/` 验证工程契约、权限、异常、事务、恢复和进程边界；`evals/` 只使用完全虚构数据，验证 Capture 候选质量、Injection 选择质量、治理和延迟。
- 正式评测门槛是 Capture、Injection、治理场景 100% 通过，安全泄露率为 0，Injection P95 不超过数据集定义门槛；challenge 场景暴露当前检索能力边界，不能为了过门禁降低标注标准。
- 适配器变更至少覆盖：setup/doctor、Capture 增量与断点、候选审核、Hook 注入、MCP 深搜、失败 fail-open、重复执行和 workspace 隔离。
- 发布前运行 `npm run release:check`、`npm run test:soak` 和 tarball/package smoke；CI 的 Ubuntu/macOS × Node 22/24 矩阵必须全部通过，不能用本地测试替代远端检查。
- 真实客户端测试只能使用虚构 workspace、临时 HOME/数据库和明确记录的客户端版本；不得把真实对话写入测试数据库、日志或评测集。
- 没有安装某个客户端时，不得伪造真实 smoke 结果；应明确区分协议测试、虚构进程黑盒、只读探针和真实客户端测试。

## 7. CLI 与人工验收重点

常用入口：

```bash
open-continuity setup <trae|claude|codex> --workspace <path>
open-continuity doctor [trae|claude|codex] --workspace <path>
open-continuity capture doctor|sync|watch|status|candidates
open-continuity capture approve <id> [--share]
open-continuity injection status|enable|disable|check-hook
open-continuity data status|cleanup|purge-transient --yes
```

人工验收必须说明入口、虚构数据、预期输出和清理方式，至少覆盖：

1. Agent setup 备份已有配置且重复执行不重复安装；
2. Capture 只读 allowlist workspace，增量同步后 checkpoint 前进，重复同步不重复导入；
3. 敏感字段被脱敏并阻断候选，普通闲聊不会自动进入长期记忆；
4. 用户批准候选后，Injection 只返回 public 记忆，private/未确认/跨 workspace 内容不泄露；
5. Hook 超时或数据库异常时 Agent 仍可继续；
6. Agent 需要更多证据时，模型可显式调用 MCP 深度查询或创建/恢复 Handoff；
7. cleanup/purge 不误删批准的长期记忆，回执和 Inbox 按期限清理。

## 8. Git、文档和发布边界

- 默认分支名称必须从远端探测，不假设是 `master`；功能开发使用 `codex/<feature-name>` 分支，默认采用“功能分支 -> PR -> CI -> 合并”。
- 不直接推送或强推受保护默认分支，不关闭分支保护，不用 `--no-verify` 绕过检查。
- Commit 和 push 是两个独立授权节点；具体个人身份、secret scan、来源审查和个人 Hook 规则以 `~/personal/AGENTS.md` 为准。
- 不要把截图、评审导出、构建产物、数据库、日志、真实 transcript、临时目录或本地配置自动加入提交；未跟踪文件默认先保留并确认用途。
- 修改公共 MCP/HTTP/CLI 契约、memory schema、scope/identity、Adapter 协议、Memory Package 或 Handoff 时，必须同步兼容性说明、迁移说明、测试和 CHANGELOG。
- README、`docs/architecture-and-roadmap.md`、`docs/compatibility.md`、`SECURITY.md` 和 `SUPPORT.md` 中的能力声明必须与当前测试证据一致；区分“已实现”“实验性”“协议验证”“真实客户端验证”和“路线图”。
- 发布前检查 npm 包文件清单、依赖审计、许可证/来源、秘密扫描、二进制/大文件/符号链接/LFS，并只使用虚构演示输出。

## 9. 当前明确非目标

除非用户明确改变范围并同步架构/测试/文档，否则不要默认实现：

- 云端托管、跨用户多租户或自动上传完整对话；
- 把全部原始对话永久保存为长期记忆；
- 依赖向量数据库、embedding、reranker、图谱遍历或模型自动归并来宣称当前 Lite 已具备语义检索；
- 关闭 Agent/MCP/Hook 的审批保护或修改第三方 Agent 源码；
- 没有公开扩展面时对闭源 Agent 做“强行注入”；
- 用一次简单样例替代多轮评测、真实链路 smoke 和失败边界测试。
