# Retrieval Core 分阶段演进

先看[项目当前状态与下一步](../project-status.md)：各阶段已交付的职责、默认与实验能力、最新问题和跨Agent接力验收范围。以下文档分别保留各次历史设计与证据。

[后续迭代计划](../next-iterations.md)提供任务接力/Beta/逐层质量/语义模型交付的实施与验收清单，并将记忆演化和多条语义证据列为独立后续方向；新增任务均未实施。

- 最新[独立相关性重排设计](./relevance-reranking.md)分开候选相关性排序与支持验证，并保留已验证基线；[质量/安全/稳定性/成本验收](./relevance-reranking-validation.md)分别展示真实改进与未解决问题。只装配到显式 Dense 实验，默认仍关闭。

- 最新[双向补召回设计](./dense-rescue.md)把排名候选与模型准入拆开；[分项验收](./dense-rescue-validation.md)同时保留失败扩窗、原标注和错误数，默认仍关闭。

本目录是 OpenContinuity RAG 内核的阶段性设计与验收入口。这里记录的是可复核的工程事实，不用路线图能力替代当前实现，也不把单次实验结果写成产品能力。

## 当前状态

- [SQLite 字面值索引](./sqlite-literal-index.md)：原始值与检索投影分离，Schema 5 使用稳定整数指针维护 FTS，内容未变时省去重建。路径/引号/转义噪声回归、原质量、权限/迁移/回滚及写入成本分开验收，既有语义 Challenge 和默认关闭模型策略保持。

- 最新[向量投影缓存与模型验证](./embedding-optimization.md)分别实现排名/缓存/模型回执；[验收](./embedding-optimization-validation.md)按共享账本与三轮容量配对记录热查询改善，保留冷启动、错选/误拒绝和验证模型资源失败。默认关闭。


- 最新[Embedding 实验接入](./embedding-integration.md)已连接真实本地模型、SQLite 派生任务/向量、流式 Dense 及 Recall/Context/Query；[工程、质量、容量验收](./embedding-integration-validation.md)分开记录。默认关闭，否定误召回、10k 线性成本和模型安装/跨平台缺口保留。以下原型与7A报告是历史阶段证据。

- [本地模型加载与验证](./embedding-hardening.md)：外置权重/平台缓存的本机 embedding 资源预算通过；新增独立文本对回执与文件完整性模块。小验证模型误判、强验证模型成本失败保留，默认 Dense 仍未接入。

- [个人版成本与 Dense 准入](./embedding-refinement.md)：窄运行组合与闲置回收、独立准入/生命周期模块；旧 Required 保持，新否定误召回与预定活跃内存预算仍失败，默认向量通道未接入。

- [个人版 Embedding 可行性验证](./embedding-feasibility.md)：本机 CPU 推理与共享进程原型跑通；安装/内存与无阈值 Dense 误召回仍阻止直接默认开启。生产向量能力尚未接入。

- 本轮[最终审查与详细复测](./phase-7a-final-audit.md)独立记录模块化边界、契约修复、三轮工程测试、各层质量及容量，不覆盖早期7A历史结果。

- 历史[7A线路收尾](./phase-7a-route-completion.md)与[验收](./phase-7a-route-completion-validation.md)：补选择策略、Runtime叶子边界、窄packer与职责/测试登记。早期7A数字按历史保留。

- 7A内部线路与测试已补全；[设计/导航](./phase-7a-module-routes.md)、[本次验收](./phase-7a-module-routes-validation.md)记录该增量证据，初次7A报告保持历史结果。

- 已交付的 **7A 模块化内核**：通道和 backend Reader 独立实现、窄消费者契约、兼容入口及依赖门禁。该阶段先完成重构与验证，随后已独立接入显式 Embedding 实验；默认向量检索继续关闭。见 [设计](./phase-7a-modular-kernel.md)、[验证](./phase-7a-validation.md) 和 [代码导航](../../src/core/README.md)。

- 6D人工配置词对实验已撤销；后续模型辅助查询改写尚未实现。现有`memory_query.subqueries`接收调用方显式查询，内核尚不会自动用模型生成它们。

- 阶段6轻量增量：6A分层诊断、6B可选SQLite英文单编辑fallback、6C收益/误召回/安全/稳定/成本消融。默认OFF，默认启用门禁不通过的失败原样记录；不是语义RAG全量完成。设计见[6A](./phase-6a-diagnostics.md)、[6B](./phase-6b-lexical-fallback.md)、[6C](./phase-6c-acceptance.md)，结果见[整阶段验收](./phase-6-validation.md)。阶段4/5已通过PR #12合并；历史首次验收状态仍保留，最新证据见[提交前复测](./phase-45-pr-validation.md)。

- 已完成基础阶段：**阶段5——运行可靠性**；5A执行预算/容量，5B进程并发/恢复，5C分入口容量/观测独立实现与验收。阶段4确定性Context/引用保留，不进入Embedding；SQL硬取消、断电、完整身份认证和生产SLO仍未实现。
- 2026-10-23：[阶段 3 设计](./phase-3-ranking.md) 和 [验证](./phase-3-validation.md)记录新结果；此前 [2C](./phase-2c-validation.md) 为独立候选交付时的历史证据，原数字保留。
- 基线来源：`core-v2` 分叉点 `e23207aa9e746c71a599af8e2a0c913c5d59bf94`；它是阶段开始时的 `origin/main` 快照。
- 原 Retrieval Core v2 Spike 已备份并校验后移出当前实现，可恢复，不属于阶段 1 交付。
- 阶段 0 不改变生产代码、公共契约、Schema、Adapter 或默认运行行为。
- 阶段运行期间 `origin/main` 已合入 Adapter hardening 并前进到 `9abe30956b67a99ff44fce11713c5838cfa364b0`；阶段 1–3 的历史基线保持原分叉。2026-10-25 的 PR 集成验证基于此已发布主线重新测试，PR 本身不修改 Adapter，也不复制其它工作区的未提交内容。

## 文档索引

- [7A内部线路](./phase-7a-module-routes.md)：模块内操作边界、共享状态、读写时序与分项测试。
- [7A内部线路验收](./phase-7a-module-routes-validation.md)：工程、独立报告、原质量与成本对照。

- [7A 模块化设计](./phase-7a-modular-kernel.md)：模块总图、单通道设计、读写时序、窄接口与迁移边界。
- [7A 独立验证](./phase-7a-validation.md)：兼容/工程、质量/安全/稳定性、成本和未实现项分别查看。


- [6A逐层诊断](./phase-6a-diagnostics.md)：虚构固定标注、实际通道/独立重放、完整校验与能力边界。
- [6A独立验收](./phase-6a-validation.md)：逐题瓶颈、不同问题数、标注局限、质量不变与下一步优先级。
- [6B有界拼写fallback](./phase-6b-lexical-fallback.md)：触发条件、权限先过滤、评分解释、游标与默认关闭。
- [6C接受协议](./phase-6c-acceptance.md)与[阶段6结果](./phase-6-validation.md)：原/新题开关消融、反例、成本及默认决策分开。

- [阶段5总览](./phase-5-runtime-reliability.md)与[独立验收](./phase-5-validation.md)：执行保护、真实进程及容量成本分开。
- [5A执行预算](./phase-5a-execution.md)：准入、deadline、迟到工作、错误与drain。
- [5B并发恢复](./phase-5b-recovery.md)：事务边界退出、幂等/CAS、WAL恢复及持续Query。
- [5C观测性能](./phase-5c-observability.md)：逐响应证据、固定回归规则和可选脱敏observer。

- [阶段4总览](./phase-4-context-and-answer.md)：选择、预算后覆盖与可引用原值答复，明确非语义问答边界。
- [阶段4独立验收](./phase-4-validation.md)：三轮公共基线、专项覆盖/引用、原生PG、成本、失败与未实现项。
- [4B预算与覆盖](./phase-4b-budget-and-coverage.md)：多查询装包、缺口、双口径充分性与完整值保留。
- [4C证据答复](./phase-4c-evidence-answer.md)：statements/版本引用、partial/abstain、一致性校验与专项评测。

- [4A Context选择](./phase-4a-context-selection.md)：默认相关性优先、用途同分破平、旧排序兼容、权限/确认边界与回执。公共质量、机制消融、性能与工程分开验收。
- [4A独立验收](./phase-4a-validation.md)：同依赖基线的三轮比较、机制消融、工程/原生PG、性能与未完成项。

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
