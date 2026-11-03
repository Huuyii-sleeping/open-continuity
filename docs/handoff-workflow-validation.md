# 交接流程：本轮验收

验收日期：2026-10-30。交付的是可审核的准备→确认→恢复流程，复用原Handoff和存储。默认不加载模型，不修改检索策略、Adapter或客户端配置。

## 已验证的用户流程

来源MCP进程准备完全虚构的任务草稿；在尚未确认时，另一次恢复返回not_found。用户通过CLI核对并确认精确指纹，随后新的MCP进程以另一个绑定Agent身份恢复同任务，得到原摘要、决策、阻碍、下一步及来源。旧来源进程可以关闭，数据仍持久化在同一临时SQLite。

测试中的调用者是协议客户端，不能据此宣称真实Claude/Codex模型已经接着完成任务。正常客户端使用方式和设计时序见[流程说明](./handoff-workflow.md)。

## 工程与存储结果

| 检查 | 本轮结果 | 证据范围 |
| --- | --- | --- |
| Typecheck / 架构门禁 | 通过；211个源码、816条边、0违规 | Core/存储依赖，不代表模型效果 |
| 受影响测试 | 66通过 | memory、四存储、CLI、MCP/HTTP、身份与审核 |
| 三轮全量（普通+两轮乱序） | 每轮830通过、64条件跳过 | 未启用的原生PG测试等条件跳过不算通过 |
| 最终分模块/线路 | 126条线路，738通过、64跳过 | 审核6、呈现2、跨存储16、CLI2、协议进程2分别保留 |
| 真实PostgreSQL17.11 | 两次独立夹具各63通过 | 包含4个审核契约；loopback、tmpfs，已确认清理 |
| 打包安装smoke | 通过 | 临时前缀安装；新CLI可准备、确认及跨Agent恢复 |

最后针对读取文件有界、UTF-8无效输入与错误存储数据分类补充检查后，再跑typecheck、全量830项、最终模块报告与package smoke，保持通过。早期PG模拟器reopen配置和fence计数断言曾失败，修正夹具/断言后重测，失败日志保留，不作为通过结果。

已验证边界包括：

- 未确认不新增memory/event；正常准备不会自动采集transcript。
- 错指纹、篡改字段/metadata/共享范围、不同用户/来源Agent、过期审核明确拒绝。
- 目标在审核后更新会冲突；删除/重建成同版本仍按memory ID与源事件拒绝，避免ABA覆盖。
- Guard与当前状态/事件写入处于同一Store事务或锁；新幂等事件只写一次，重放原回执不恢复已遗忘状态。
- 默认private、隐藏private目标、跨用户/任务、HTTP API key与MCP绑定身份保持；新冲突不输出隐藏记录细节。
- 错绑来源、未确认或损坏的存储记录不返回ready交接。
- CLI文件读取最多256KiB，拒绝无效UTF-8/过大/非regular输入；新草稿owner-only，不覆盖已有文件。
- 审核与接手文本将控制字符/引用数据保留在可识别的表示中，不执行产物路径或把引用文本升为用户指令。

这些边界仍依赖受信任调用方真实传达用户确认。Boolean、SHA-256和快照guard不是登录认证、数字签名或完整多租户授权。旧直接create兼容路径不等于新的审核确认协议，必须按实际capability选择入口。

## 原质量与性能回归

以本轮开始的完整本工作区源码快照为Before，默认评测逐项核对。`eval:suite` 两侧185/185，安全0/40；`eval:quality` 两侧Required15/15、Challenge9/42、总24/57，安全0/6。标注未改变；没有把流程新增测试数写成召回提升。

本轮 `benchmark:lite` 使用原虚构10k数据、100请求，P95为Exact1.774ms、FTS3.360ms、Context3.460ms，建库8102.659ms。这是一次本机回归记录，不是交接延迟、模型加速或生产SLO；语义实验的既有质量/成本见其独立验收。

## 真实模型接手：未验证

隔离Codex CLI0.162.1连接探针使用临时HOME/CODEX_HOME、`--ephemeral --ignore-user-config`，没有复制用户配置/凭据或读取真实历史。实际模型请求返回401缺少认证，进程退出1。因此没有生成实际任务计划或CSV产物，任务完成率、正确采用上下文、遗漏/重复工作、用户补充次数全部保持未验证，不能填0或100%。

后续在隔离客户端具备有效测试登录后，沿用相同虚构项目：先验证B认识已完成的JSON导出、保留离线约束并询问时区，再在用户确认后继续CSV。真实模型结果、协议黑盒和默认检索成绩继续分别记录。

## 本机证据

本机仓库外目录名为 `open-continuity-handoff-workflow-20261030.dg5kdgfq`，不加入包或提交：

- `before/`：本轮开始的自己的完整源码快照。
- `reports/modules-final/`：最终各模块/线路、源码与测试指纹。
- `logs/full-round1..3.log`、`hardening-full.log`：重复工程验证。
- `logs/postgres-real.log`、`postgres-real-final.log`：两次真实PG与清理确认。
- `logs/hardening-package.log`：安装后的真实CLI流程。
- `logs/before-suite.log` / `suite.log`、`before-quality.log` / `quality.log`：默认质量对照。
- `reports/real-client-probe.json`：真实模型不可用状态；`review-example.md`为真实渲染、完全虚构的审核页面。

最近检索改动与本增量均保留为未提交工作区内容，本轮不commit/push，不用本地通过替代远端CI或发布。
