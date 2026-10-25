# Retrieval Core 分阶段演进

本目录是 OpenContinuity RAG 内核的阶段性设计与验收入口。这里记录的是可复核的工程事实，不用路线图能力替代当前实现，也不把单次实验结果写成产品能力。

## 当前状态

- 当前阶段：**阶段 3 的 3C——显式事实有效性与保守裁决**已完成本地验收。3A/3B 的公共排名与回执保留；未声明的语义关系、来源真实性与性能 SLO 仍未实现，不把基础版等同于完整成熟 RAG。阶段 4 未开始。
- 2026-10-23：[阶段 3 设计](./phase-3-ranking.md) 和 [验证](./phase-3-validation.md)记录新结果；此前 [2C](./phase-2c-validation.md) 为独立候选交付时的历史证据，原数字保留。
- 基线来源：`core-v2` 分叉点 `e23207aa9e746c71a599af8e2a0c913c5d59bf94`；它是阶段开始时的 `origin/main` 快照。
- 原 Retrieval Core v2 Spike 已备份并校验后移出当前实现，可恢复，不属于阶段 1 交付。
- 阶段 0 不改变生产代码、公共契约、Schema、Adapter 或默认运行行为。
- 阶段运行期间 `origin/main` 已合入 Adapter hardening 并前进到 `9abe30956b67a99ff44fce11713c5838cfa364b0`；阶段 1–3 的历史基线保持原分叉。2026-10-25 的 PR 集成验证基于此已发布主线重新测试，PR 本身不修改 Adapter，也不复制其它工作区的未提交内容。

## 文档索引

- [阶段 3 公共排名](./phase-3-ranking.md)：原始分数/融合、Exact 优先、Structured 零贡献、查询游标和版本一致性。
- [阶段 3 验证](./phase-3-validation.md)：阶段 2 复测、公共质量前后对比、消融、性能和剩余工作。
- [3C 显式事实](./phase-3c-fact-design.md)：调用方声明、有效期、替代版本、可见组核实、冲突/缺证据拒答与迁移边界。
- [3C 独立验收](./phase-3c-validation.md)：原基线不变、新声明专项、安全/稳定性、容量成本与最终冻结命令。
- [阶段 2 候选召回](./phase-2-candidates.md)：显式 Core 入口、公共行为不变、范围与限制。
- [2A 证据契约](./phase-2a-contract.md)：rank、原始分数模型/方向、匹配依据与空值语义。
- [2B 召回通道](./phase-2b-retrievers.md)：独立 Exact/Structured、SQLite BM25/短查询与其它存储 fallback。
- [2C 独立验收](./phase-2c-validation.md)：质量/安全/稳定/容量/工程证据及 BM25 消融，区别公共查询与原生 PG 工程证据。
- [阶段 1 存储实现](./phase-1-storage.md)：职责契约、写入/恢复、游标兼容、独立存储证据与未验证项。
- [阶段 1 独立验收](./phase-1-validation.md)：存储、召回、Context、安全、稳定性、性能与工程证据分开查看。
- [1B 写入与恢复](./phase-1b-writes.md)：回滚失败、未知提交回执、幂等事件类型和真实数据库证据。
- [1C 分页与能力](./phase-1c-pagination.md)：cursor 边界、静态分页/并发快照区别、权限与 fallback 声明。
- [1B/1C 补验记录](./phase-1bc-validation.md)：最新工程命令与分层质量/性能报告，原始历史结果不覆盖。
- [可执行基线与独立报告](./baseline-framework.md)：重现、指标协议、分层查看、回归门禁和覆盖缺口。
- [本次补强验证](./baseline-validation.md)：召回、Context、安全、稳定性、容量与工程结果分别记录；Spike 未过门禁。
- [阶段 0 基线](./phase-0-baseline.md)：命令、环境、质量/性能结果、评测盲区和解释限制。
- [当前契约与不变量](./contracts-and-invariants.md)：调用链、模块职责、能力矩阵、权限边界和事实—声明差异。
- [阶段门](./stage-gates.md)：阶段 1 以后每次实现必须提交的证据和进入下一阶段的条件。
- [机器可读基线](../../evals/baselines/retrieval-core-phase-0.json)：阶段 0 结果的结构化快照。

## 目标内核分层

```text
Public Query API
    ↓
Request / Policy Context
    ↓
Eligibility Gate
    ↓
Candidate Retrieval
    ↓
Retrieval Evidence Contract
    ↓
Ranking / Fusion / Fact Resolution
    ↓
Recall | Context Pack | Answer

Trusted Storage Core and Reliability Plane constrain every layer.
```

后续实现必须保持以下职责分离：

1. 存储负责可靠保存、版本、事务、幂等、过滤和稳定分页，不负责回答问题。
2. Retriever 负责独立产生候选，并单独报告召回质量。
3. Ranker/Fusion 负责候选顺序，不能把时间顺序或权限过滤冒充相关性。
4. Context Pack 负责确认状态、可见性和预算，不扩大检索权限。
5. Answer 负责证据组织、引用和拒答，不能绕过 Retrieval 直接扫描存储。

## 状态词汇

所有能力声明只使用以下状态：

- **implemented**：代码、契约测试和对应评测均有证据。
- **fallback**：存在可靠但能力较弱的降级实现，必须说明差异。
- **challenge**：数据集已覆盖，但当前实现没有稳定通过。
- **roadmap**：尚未实现，不得出现在当前能力声明中。
