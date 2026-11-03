# 内核模块导航

[交接流程](../../docs/handoff-workflow.md)新增 `memory/handoff/review.ts`（只读准备与确认绑定）、`write-guard.ts`（既有事务内快照检查）和 `render.ts`（审核/接手输出）。`application`装配到原Handoff；各Store复用 `resolveEvolution`，不新增数据库连接或模型依赖。`test:core -- --module=memory --route=handoff-review` / `handoff-render` 与跨存储 `handoff-review-storage` 分别验证。

最新[相关性重排](../../docs/retrieval-core/relevance-reranking.md)由 `retrieval/reranking/` 独立提供模型评分/生命周期/绑定校验，`dense/reranking/` 负责纯排序、保留基线的选择及回执验证。使用 `test:core -- --module=retrieval --route=relevance-reranker`、`--route=reranking-order`、`--route=dense-reranking` 分别定位。它只作用于显式 Dense 的授权窗口，默认不加载模型。

最新[双向补召回](../../docs/retrieval-core/dense-rescue.md)由 `retrieval/dense/rescue.ts` 独立决策和编排窗口；`local-pair-verifier.ts`提供绑定方向的判断，`retriever.ts`统一授权排名、模型身份和共享 deadline。`npm run test:core -- --module=retrieval --route=dense-rescue`可独立定位该线路。默认仍为字面检索，旧显式 Dense 策略保持。

最新[投影缓存与模型验证](../../docs/retrieval-core/embedding-optimization.md)把 `retrieval/dense/ranker.ts`、`snapshot-cache.ts`、`local-pair-verifier.ts` 与 `verification/contracts.ts` 独立实现。SQLite 通过向量投影和受资格约束的正文接口协作；缓存和模型均有预算/版本边界，默认工厂仍不装配模型。验证回执随评分证据传入 Recall/Context/Query。


先看 [7A 设计](../../docs/retrieval-core/phase-7a-modular-kernel.md) 与 [内部线路补全](../../docs/retrieval-core/phase-7a-module-routes.md)。目录表示职责，公共工具仍由同一个 `MemoryService` 组合。

最新 [线路收尾](../../docs/retrieval-core/phase-7a-route-completion.md) 补齐Context选择策略、Runtime读取包装/回执、Query预算后判定，以及存储各操作的直接契约测试。初次分组报告为历史证据，当前职责登记和分项结果由真实文件核对。

最终审查与详细分层复测见 [7A审查验收](../../docs/retrieval-core/phase-7a-final-audit.md)。无分数证据仍须使用合法模型/方向，未执行或跳过批次不能声称命中；测试文件状态与已执行断言矛盾的报告会被拒绝。

后续[本地模型成本与准入实验](../../docs/retrieval-core/embedding-refinement.md)增加 `runtime/model-owner.ts` 与 `retrieval/dense/admission.ts` 两个独立 staged 模块；前者依赖模型资源 port，后者只接受已授权评分证据。两者未装配到默认服务，不表示新增生产向量能力。

[加载与验证增量](../../docs/retrieval-core/embedding-hardening.md)新增 `retrieval/dense/pair-verification.ts`（定向文本对支持/矛盾回执）和 `runtime/model-artifacts.ts`（显式清单的流式完整性），同样未装配到默认服务。模型运行包与派生权重不进入 Core，质量/资源实验独立于契约测试。

```text
core/
  application/       服务装配、存储工厂、实际能力声明
  memory/            写入/事件/版本/幂等与存储契约
  policy/            访问与作用域规则
  runtime/           Profile / policy / deadline / store-guard / observer；read-runtime持有容量和drain
  pagination/        游标编码与验证
  retrieval/
    contracts.ts     单通道输入、评分证据、窄读取接口
    candidates.ts    注册与有界调度
    retrievers/      exact / structured / full-text 独立入口
    dense/           模型/索引窄契约、准入、流式前列比较与评分验证；显式实验入口
    reranking/       独立相关性模型、有限生命周期、评分绑定；无数据库/准入副作用
    full-text/       可选拼写算法与证据校验
    ranking.ts       排名编排；ranking/ 拆候选一致性、单路/最佳排名、RRF 与评分解释
    validation.ts    批次一致性检查
    pipeline.ts      候选、排名、事实和分页的编排
    legacy/          旧 Store / 自定义 Retriever 桥接
  facts/             group-reader / validity / references / adjudication / resolution
  context/           selection/ 拆资格、信号、relevance / input-order / legacy；packing/ 拆 budget / rank / coverage
  query/             planner / recall / history / evidence / fact-review / response / sufficiency / budgeted-sufficiency / fallback
  answer/            validation / citations / statements / evidence-answer
```

`src/storage/` 保存具体数据库实现。每个 backend 的 `readers/` 独立实现 Exact、Structured、Full-text，并共享该 backend 的资格过滤；Core 不导入数据库驱动。`application/` 是装配例外。通用迁移命令位于 `src/cli/storage/`。

Context 依赖 `RecallReader`；Query 依赖 `QueryEvidenceReader` 和 `MemoryHistoryReader`，都不依赖具体 Pipeline/Service。默认服务不启用向量；显式实验的 provider / index port、流式 Dense 通道、组合与一致性见 [接入设计](../../docs/retrieval-core/embedding-integration.md)。

存储内部 `writes/` 拆Remember/Forget，`records/` 拆列表/历史/事实组；SQLite `transfer/` 拆导入重放/导出，InMemory操作共用同一状态，JSON只做兼容委托。Store持有连接/事务/初始化，不让每条线路各建连接。Memory的merge/evolution/ledger/handoff独立，Pagination拆records/retrieval，Runtime的deadline独立于准入/容量。

旧 `src/core/*.ts`、`src/sqlite/*.ts`、`src/postgres/*.ts` 仅保留 re-export 兼容入口；新代码使用上述目录。旧命令入口仍会执行对应命令，不能当作无副作用模块导入。跨快照评测器有意使用旧入口，方便同一个评测器读取前后版本。

```bash
npm run check:architecture
npm run test:core:list
npm run test:core -- --module=query --route=history
npm run test:core -- --module=context --route=packing-budget
npm run test:core -- --report-dir=<仓库外新目录>
```

依赖检查覆盖静态 import/export、字面动态 import 与 import type，阻止数据库越层、具体消费者依赖、通道互相调用及兼容入口重新长出业务。它不证明运行时行为正确；权限、错误、分页、质量与包安装另有测试。

分模块测试保存完整网格、源码/测试/夹具/脚本/锁文件指纹和逐线路状态。未知或空选择、零断言、缺失或重复结果不能通过。条件跳过显示skipped/partial；失败位置是观测位置，不等于自动定位根因。真实PG另用虚构Docker夹具。测试CLI为开发工具，不属于安装后的产品命令。

`scripts/core-contract-map.ts`登记主要职责对应的实现与测试文件，单元/backend契约/集成分别标明，文件缺失会阻止验收。登记不等于行/分支覆盖，也不穷举每个辅助函数。每个文件都必须有断言，不能借同组其它文件的通过结果；duplicate、unknown status与负耗时也不能进入合法报告。存储`operations-read/write`旧选择名兼容映射到`history-port/forget-port`，实际报告使用后者。
