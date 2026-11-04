# OpenContinuity

[![CI](https://github.com/Huuyii-sleeping/open-continuity/actions/workflows/ci.yml/badge.svg)](https://github.com/Huuyii-sleeping/open-continuity/actions/workflows/ci.yml)
[MIT](LICENSE) · Node.js 22.13+ · Developer Preview

**本地优先、用户可控的跨 Agent 共享记忆与任务交接层。**

在 Trae、Claude Code、Codex 之间切换时，让已确认的偏好、项目约束和任务进度仍可被检索、核对和使用。记忆默认保存在本机，用户决定哪些内容留下、共享给谁，以及何时修改或遗忘。

[快速开始](#快速开始) · [使用指南](docs/usage.md) · [客户端兼容性](docs/compatibility.md) · [路线图](docs/next-iterations.md) · [参与贡献](#参与贡献)

## 可以用来做什么

- **共享偏好和约束**：在一个 Agent 中明确保存回答风格、项目约定，换到另一个 Agent 后按需查询。
- **从对话中选择记忆**：可观测对话先进入本地 Inbox，提取为待审核候选，用户批准后才进入长期记忆。
- **交接正在进行的任务**：准备摘要、决策、已完成内容、阻碍和下一步，审核确认后由接手 Agent 恢复。
- **管理记忆生命周期**：查看来源和版本历史，更新、遗忘、备份或导出自己的记忆。

## 工作方式

```mermaid
flowchart LR
  A[Agent A 的可观测对话] --> I[本地 Inbox 与候选]
  I --> U[用户审核]
  U --> M[长期共享记忆<br/>SQLite]
  M --> R[轻量注入 / MCP 查询]
  R --> B[Agent B 获得上下文]
```

Capture 与 Injection 使用客户端公开的扩展面。MCP 也提供直接记忆写入和准备、确认、恢复交接的入口；调用方须真实传达用户授权。MCP 工具是否被调用、上下文是否被正确采用，由客户端和模型的工具策略决定。

## 当前能力

| 能力 | 状态 |
| --- | --- |
| 本地共享记忆 | Lite 使用 SQLite，具备事务、幂等写入、版本、scope 和审计历史 |
| 默认检索 | 独立 Exact、Structured、Full-text 通道；SQLite FTS5/BM25 排名，有预算的 Context 与多步 Query |
| 任务交接 | CLI、MCP、HTTP 支持准备草稿 → 用户审核 → 确认 → 恢复，包含过期和并发版本检查 |
| Agent 适配 | Trae、Claude Code、Codex 有实验性 Capture/Injection Adapter；其它支持自定义 MCP 的客户端可使用 MCP |
| 可选语义检索 | SQLite Embedding、Dense、相关性重排和支持验证为显式 Core 实验，默认关闭 |
| 部署 | Lite 是主要验证路径；Team/PostgreSQL 为实现预览；Enterprise 尚未实现 |

当前候选版本为 `1.1.0-beta.1`，处于 **Developer Preview**。建议先用虚构或可恢复的数据评估。客户端验证程度、真实模型任务接力的未验证项，以及语义实验的质量/资源限制，见[兼容性矩阵](docs/compatibility.md)、[当前状态](docs/project-status.md)和[支持策略](SUPPORT.md)。

## 快速开始

### 1. 从源码运行

需要 Node.js **22.13 或更高版本**和 npm。macOS/Linux 的 Node 22/24 由 CI 覆盖；Lite 无需 Docker、独立数据库服务或 Embedding 模型。

```bash
git clone https://github.com/Huuyii-sleeping/open-continuity.git
cd open-continuity
npm ci
npm run build
node dist/src/cli.js demo
```

`demo` 使用完全虚构的数据和临时 SQLite，验证两个 MCP 客户端之间的记忆持久化与交接恢复，并自动清理数据库。它无需初始化或安装 Agent；这是协议演示，真实模型接手效果另行验收。

目前采用源码运行方式；公开包的分发状态见[当前状态](docs/project-status.md)。以下命令均在仓库根目录执行。连接客户端后，请保留这个稳定的安装路径；全局命令安装方式见[使用指南](docs/usage.md#源码运行与本地配置)。

### 2. 连接一个 Agent

以已安装的 Codex CLI 为例，将 `/absolute/path/to/your-project` 替换为你允许访问的项目目录：

```bash
node dist/src/cli.js init
node dist/src/cli.js setup codex --workspace /absolute/path/to/your-project
node dist/src/cli.js doctor codex --workspace /absolute/path/to/your-project
```

使用 Claude Code 或 Trae 时，将 `codex` 替换为 `claude` 或 `trae`。`setup` 会备份已有配置，并设置对应客户端的 MCP、Capture/Injection 和 workspace allowlist。安装后重启会话，按客户端要求检查 Hook 信任和 MCP 审批：Codex/Trae 需检查 `/hooks`，Claude Code 需重新加载会话设置。

如果只需要 MCP，可使用 `connect <agent>`；Codex 的 app-server 不可用时也可采用 MCP-only。各客户端的条件、故障排查及 Trae 后台服务说明见[使用指南](docs/usage.md#连接与客户端边界)。

### 3. 审核一条对话记忆

在已授权项目中完成一次可观测对话后，查看候选：

```bash
node dist/src/cli.js capture candidates
```

核对内容和来源。只有认可该候选并希望同一用户的其它 Agent 使用时，才替换下方 ID 并批准共享：

```bash
node dist/src/cli.js capture approve "<candidate-id>" --share
node dist/src/cli.js memories list
```

不加 `--share` 的候选批准默认写为 private。候选来源与触发方式随客户端不同：Claude/Codex 使用 Stop Hook，Trae 使用同步/watch；没有候选时先运行对应的 `doctor`，见[候选审核](docs/usage.md#候选审核与轻量注入)。

随后可在另一个已连接 Agent 中明确要求它使用 `memory_context` 或 `memory_recall` 查询这条已确认记忆。工具调用和结果可见性仍受客户端策略及记忆 scope/private 边界约束。

## 任务交接

1. 对来源 Agent 说：**“准备交接这个任务，用 `memory_handoff_prepare` 列出已完成内容、决策、阻碍和下一步，先给我审核。”**
2. 核对草稿及 public/private 范围，再明确确认；来源 Agent 用原草稿和指纹调用 `memory_handoff_confirm`。
3. 对接手 Agent 说：**“用 `memory_handoff_resume` 恢复任务〔任务编号〕，核对进度和阻碍后继续。”**

新草稿默认 private；跨 Agent 使用时需明确选择 public 并确认。目标版本已改变或草稿过期时，需要重新准备和审核。

完整 CLI 示例、流程图和验证边界见[交接指南](docs/handoff-workflow.md)。

## MCP 与 HTTP

MCP stdio 是连接 Agent 的主要入口；HTTP 默认监听 `127.0.0.1:8787`，适合本地应用集成。

| 工具 | 用途 |
| --- | --- |
| `memory_capabilities` | 查看当前 Profile 和实际配置能力 |
| `memory_remember` / `memory_recall` | 保存用户授权的结构化记忆、检索当前记忆 |
| `memory_context` / `memory_query` | 生成有预算的上下文、执行有预算的多步检索 |
| `memory_history` / `memory_forget` | 查看审计历史、遗忘记忆 |
| `memory_handoff_prepare` / `memory_handoff_confirm` / `memory_handoff_resume` | 可审核的任务交接 |
| `memory_handoff_create` | 兼容旧客户端的直接创建交接入口 |

共 11 个工具。手动 MCP 配置、HTTP 端点、查询与更新契约见[使用指南](docs/usage.md#mcp-与-http-集成)。

## 数据与隐私

- 默认数据目录为 `~/.open-continuity/`。长期记忆、短期 Inbox 和注入回执分开保留；候选经显式审核后才进入长期记忆。
- Capture 只处理 allowlist 内公开扩展面可观测的内容。MCP 不提供完整聊天历史，隐藏 reasoning 不持久化。
- Injection 只使用已批准、public、workspace 可见的少量记忆，超时或存储异常时 fail open；回执保存短 Prompt 指纹，保留策略见[使用指南](docs/usage.md#数据保留与安全配置)。
- OpenContinuity 默认不主动上传记忆。接收上下文的第三方 Agent 仍可能按其自身配置将 Prompt 发送给模型服务。
- 身份与用户确认依赖可信调用方。当前提供本地 scope/private 策略，未实现完整多租户认证、静态数据加密或生产支持承诺。

数据查看、备份、恢复、导入导出与清理见[使用指南](docs/usage.md#记忆管理与备份)。安全边界及漏洞报告方式见 [SECURITY.md](SECURITY.md)。

## 文档

| 想了解什么 | 文档 |
| --- | --- |
| 配置、管理命令、MCP/HTTP、查询契约 | [使用指南](docs/usage.md) |
| 准备、确认与恢复任务 | [交接指南](docs/handoff-workflow.md) |
| 哪些客户端路径真正验证过 | [兼容性矩阵](docs/compatibility.md) |
| 内核设计与代码组织 | [架构](docs/architecture-and-roadmap.md) · [Core 导航](src/core/README.md) |
| 质量、安全、性能如何评测 | [评测与基准](docs/benchmarking.md) |
| 已实现、实验和未验证内容 | [项目状态](docs/project-status.md) |
| 接下来做什么、怎么验收 | [后续迭代计划](docs/next-iterations.md) |
| 各次设计与历史证据 | [内核阶段索引](docs/retrieval-core/README.md) · [CHANGELOG](CHANGELOG.md) |

## 开发与测试

在完成源码安装后运行：

```bash
npm run typecheck
npm run check:architecture
npm test
npm run eval:suite
npm run eval:quality
```

内核可以按模块、线路分别测试，见 [Core 导航](src/core/README.md)。测试和评测仅使用虚构数据；发布前检查与安装包验收见[发布清单](docs/release-checklist.md)。

## 参与贡献

欢迎通过 [Issues](https://github.com/Huuyii-sleeping/open-continuity/issues) 提交可复现的问题、兼容性报告或功能建议。大型协议和架构改动先讨论；贡献流程见 [CONTRIBUTING.md](CONTRIBUTING.md)，社区约定见 [CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md)。

公开问题报告请使用虚构数据和最小复现；安全问题按 [SECURITY.md](SECURITY.md) 报告。支持范围见 [SUPPORT.md](SUPPORT.md)。

## 许可证

[MIT](LICENSE) © Huuyii-sleeping
