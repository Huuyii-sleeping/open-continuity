# Lite benchmark

## Reviewed Handoff workflow

[Workflow validation](./handoff-workflow-validation.md) keeps protocol and actual Agent task results separate. Core/backend checks cover content/actor/approval bindings, expiry, atomic stale and delete/recreate rejection, private/scope isolation, idempotent retries and reopen. Cross-process evidence uses MCP preparation, CLI confirmation and a fresh MCP receiver; package smoke repeats the normal CLI path in an isolated install. These do not produce a model task-completion percentage.

The real-client test uses a fictional workspace, temporary HOME/CODEX_HOME and no copied user configuration/history. Authentication failure or unavailable inference is `unverified`, not success. Existing `eval:suite`, `eval:quality` and `benchmark:lite` remain separate default-path regressions with unchanged labels; this increment does not claim a new retrieval score improvement.

## Dense候选相关性重排实验

[分项验收](./retrieval-core/relevance-reranking-validation.md)以本轮开始的完整工作区 Core 为 Before，与显式重排的 After 共用同一新评测器、事件账本、原模型和准入阈值。旧五组96题与新248条候选池的16题分别报告；新增题在首次模型推理前冻结，但作者生成且最终为已暴露回归，不能称独立盲测。候选排名诊断不作为最终出口召回结果；负例误召回与正例错选分开。

复现：`npm run eval:dense -- --provider=<local-provider> --verifier=<local-verifier> --reranker=<local-reranker> --dataset=evals/datasets/reranking-window-challenge-v1.json --output=<outside-repo.json>`。`--reranking-candidates` 为4–20，默认20；重排支持验证默认最多1条，原基线验证最多4条。模型模块必须导出 `createReranker`，不自动安装/下载。原余弦0.62/margin0.14、NLI0.5/0.5与标注保持，raw logit没有零点准入门槛。

重复请求的判断缓存、首次查询、模型准备和无缓存模型推理分别记录。推理不可用、绑定错误、索引失效和 deadline 拒绝计分，不能把 fail-open 当作成功。超过100条的索引按批推进，无进展或尝试超过10000次停止。普通 `benchmark:lite` 继续独立比较默认无模型路径。

## 双向补召回实验

[分项验收](./retrieval-core/dense-rescue-validation.md)比较冻结的本工作区 Before 与显式 `bidirectional_rescue`，沿用原四组标注、模型和阈值；新增 `dense-rescue-challenge-v1` 在首次推理前冻结，随后暴露的问题用于完善矛盾停止规则，因此最终成绩是已暴露回归，不能称独立盲测。三轮新进程交错配对，每组共用同一事件账本，每出口重复三次。失败扩窗方案、误选择数、无答案误召回、权限分母、稳定性和原始耗时均保留。

复现：`npm run eval:dense -- --provider=<local-provider> --verifier=<local-verifier> --compare-rescue --dataset=evals/datasets/dense-rescue-challenge-v1.json --output=<outside-repo.json>`。需要重现旧第四组时，单独使用 `--dataset=evals/datasets/dense-verifier-challenge-v1.json`。索引代次变化、双向推理不可用和 deadline 都拒绝计分；不把 fail-open 或判断缓存命中当作准确性或模型速度。

## SQLite 字面值索引与写入维护

[本次设计与分项验收](./retrieval-core/sqlite-literal-index.md)独立比较原 `core-baseline-v1`、原 `candidate-v1` 和新增 `literal-value-v1.json`；新增集使用既有 candidate 契约格式，14 个完全虚构、已暴露的回归题，不称盲测或语义收益。SQLite 新集与旧源码采用同一评测器/标注/阈值；负例误召回、Recall@K、MRR、稳定性和权限分母分别保留。

复现新集：`npm run eval:candidates -- --backends=sqlite --dataset=evals/datasets/literal-value-v1.json --report-dir=<new-dir>`；以 `--source=<clean-before>` 建立参考，再加 `--compare=<before>/raw-report.json`。旧源码在新 Required 回归中非零退出是缺陷证据，执行异常不能当作有效参考。原质量仍使用原命令单独比较。

写入成本另测 1k/10k、同一虚构事件账本、三轮新进程 B→A/A→B/B→A，每种操作预热 10 次、保留 100 个样本。更新、仅元数据更新、删除、Exact、全文分开，首次导入计时另列；不清 OS 页缓存，不将某项更快替代其它成本或生产 SLO。普通 `benchmark:lite` 继续独立执行。

[投影缓存与候选验证验收](./retrieval-core/embedding-optimization-validation.md)按同一事件账本重放各臂，固定 ID、事件、版本、时间戳和正文。质量对照分别显示 Legacy/优化、无验证/有验证，原标注与阈值不变；另禁用判断缓存做三次模型重载。1k/10k 采用新进程三轮交错配对，冷请求、热 P95、主进程峰值和模型进程成本单独报告；不以缓存命中等同模型推理速度。`eval:dense` 可显式追加 `--verifier`、`--dataset`、`--compare-ranking`，没有自动安装或下载。


[Embedding 实际接入验收](./retrieval-core/embedding-integration-validation.md)分开报告真实 Core/SQLite 的 OFF、保守 miss-only 与实验 hybrid，以及 Recall/Context/Query 三个出口；quality-v1 和两组既有虚构回归池标注不变，三次固定夹具复查。模型未加载/索引失败会阻止评测，不能当作“无误召回”。1k/10k 完整 Context 成本与单模型成本分开；流式扫描前后的慢结果保留，未通过默认语义质量门禁。复现：`npm run eval:dense -- --provider=<显式本地模块> --output=<仓库外报告>`，不自动安装或下载模型。

## 本地模型加载与文本对验证

[加载优化与验证](./retrieval-core/embedding-hardening.md)以同一固定 q8 embedding 权重、CPU2、每臂新进程/5预热/50样本做三轮前后交错；文件逻辑字节与 RSS/P95 分开，不宣称提速。外置图/权重先核对张量 hash，再做109条 token/向量一致性；未改变学习参数。模型文件校验流式执行，其耗时不算热推理。

文本对验证将原18题验收保留为已暴露回归，新增冻结24题（12正/12负）与原校准分别报告；沿用 Dense 校准值和预定 NLI 阈值，不按验收结果调参。三轮强模型选择稳定，小模型新负例4/12与强模型双驻留约641MiB的失败均保留；原生产评测和权限不受模型实验改变。作者生成的数据不冒充独立盲测；小模型协议/源文件校验通过不等于质量通过，強模型质量通过也不等于个人版资源预算通过。

## 个人版成本与 Dense 准入

[本轮实验](./retrieval-core/embedding-refinement.md)用同一 q8 模型做 native 窄组合的三轮前后交错比较，逻辑文件字节、进程 RSS、冷加载、热请求分开；原始慢样本保留。测量前固定文件/驻留/峰值/延迟预算，驻留预算失败不调整为通过。109 条 token/向量一致性与真实 idle 退出分别记录；WASM 成本失败保留，不混入选定路径。

准入用不同虚构校准/验收池各 18 题，阈值只在校准池拟合并冻结，再跑验收和原 20 题；模型/执行/策略指纹绑定。校准新增 5/11 正例且 0/7 负例，不代表验收通过：新验收仍有 2/7 否定误召回。旧 Required/标注/权限保持，词典与按题规则未加入。纯 Core 决策/生命周期测试与真实模型试验独立；默认 pipeline、模型依赖、schema 不变，Windows/Linux 尚未验证。

## 个人版 Embedding 可行性原型

[独立实验](./retrieval-core/embedding-feasibility.md)分别记录首次安装失败/重试、两个固定多语言 q8 模型的三轮冷加载与短请求、四客户端共用模型、冻结旧题/新增噪声池的 OFF/Dense-only/实验融合，以及 1k/10k 内存向量扫描。模型在仓库外运行，当前生产 pipeline 与标注不变。Recall/MRR 的正例收益与 Required/负例退化同时保留；无相关性阈值的实验融合不通过默认接入标准。进程 RSS 不等于物理独占内存，短模型调用/单轮向量扫描不等于完整 Query 或生产 SLO；Windows/Linux、真实 Hook 和向量版本同步尚未验证。

## 7A：模块化前后行为与成本

[最终详细复测](./retrieval-core/phase-7a-final-audit.md)保留三轮正常/乱序工程结果、专项评测、原公共基线对照、1k/10k三入口并发容量和三轮Lite配对。不同指标与分母分开，消融或可选拼写失败不能因其它门禁通过被隐藏。

最新[线路收尾验收](./retrieval-core/phase-7a-route-completion-validation.md)以本轮开始的7A内部线路交付为Before，沿用原评测器比较和预设性能回归预算；分项工程/职责登记单独报告。原标注、Challenge与默认关闭拼写策略保持。

内部线路补全独立复测，见 [新验收](./retrieval-core/phase-7a-module-routes-validation.md)。以初次7A交付工作区为Before，保持标注/阈值；`test:core`分模块/线路报告工程结果，质量/安全/稳定/性能仍用各自评测命令，不能将测试分组数当作召回收益。

本轮保持算法、标注、阈值和依赖不变。使用本轮开始时完整源码快照与新源码，在同一当前评测器下分别运行 `eval:baseline`、`eval:diagnostics`，再用 `--compare=<before>/raw-report.json` 核对完整网格、各存储/入口及逐题结果。工程门禁、原质量、Challenge、安全、稳定性和性能分开记录；不把测试增加数当作召回提升。

`benchmark:lite` 保持虚构 10k 记忆、100 次请求，串行运行三组前后配对并交替顺序，保留每轮 P50/P95/max 和写入成本。重构观察预算预先设为三轮 P95 中位数 `after ≤ before × 1.25 + 1ms`；这是本机回归检查，不是生产 SLO。拼写消融继续单独运行，默认启用失败不能因重构变为通过。命令、结果、兼容游标与安装包验证见 [7A 验证](./retrieval-core/phase-7a-validation.md)。

## 6B/6C：拼写fallback消融与默认接受

`npm run eval:lexical -- --report-dir=<new-dir>`在同一源码/锁文件/Node/权限/预算下对照OFF与ON。原38题与新增16个已暴露虚构验收题各自保存off/on完整逐层报告和逐题对照；单编辑、字面保护、负例、合法词歧义、语义Challenge与安全分组独立。Recall@1/3/5、MRR、nDCG、miss、false selection仍可重算；负例没有相关标注时Recall/MRR为null，不硬编码通过。

性能单独保存`performance.json`：1k/10k、三轮、20次预热、100正式请求，字面命中/可纠正无字面命中/真正缺失/宽噪声分别测OFF/ON，每次交错执行顺序，P50/P95/P99及原始样本保留。预先固定三轮P95中位数预算`ON≤OFF×2+2ms`，不是跨机器SLO。限100次核验并不限制SQLite内部索引/排序工作。

`decision.json`区分工程完整性/安全与默认开启门禁：命令退出0仅表示有效完成实验，不意味着ON全部质量/成本通过。合法词歧义新增误召回、宽噪声成本失败阻止默认开启；当前默认OFF，旧默认质量不变。当前结果见[阶段6验收](./retrieval-core/phase-6-validation.md)，协议见[6C](./retrieval-core/phase-6c-acceptance.md)。

## 6A：逐层诊断，不改变生产检索

`npm run eval:diagnostics -- --source=<frozen-source> --report-dir=<new-dir>`，再用同评测器`--compare=<before>/raw-report.json`复测。旧core-baseline-v1的20题/相关性等级保持；8个开发题与10个已暴露验收题独立报告。四存储×三入口×三重建=1368行，每行三次技术重复，共4104响应，不是4104个独立问题。固定验收已被实现者看见，不能宣称盲测held-out或真实查询泛化。

实际候选通道与limit100诊断扩窗分开；Recall/Context排名为单独同策略重放，Query排名取实际evidence。扩窗结果不改变正式响应、不提供无限扫描；若仍截断，缺失标记“未观察到”，不假称无匹配。Structured仅资格，不算问题召回。预算省略与干扰项排前可并列归因，不能用预算标签遮蔽排序问题。显式事实拒绝、未声明当前事实、正常权限过滤与越界泄露独立。

报告的diagnosis/candidates/ranking/context/facts/security/stability/latency分别按存储/分区/入口输出；没有综合总分。安全分母0记null/未覆盖。门禁校验全网格、原始版本/值/引用、候选前缀、相关性标注和指标重算；Challenge质量失败保留，不阻断诊断工具正确性，Required/泄露/运行异常/不一致必须阻断。小样例延迟仅描述实际调用（包含离线记录开销，排除后续诊断重放），容量/SLO仍单独验证。

## 阶段5：运行保护与分入口容量

`npm run test:reliability`独立运行执行/真实进程/报告校验；`npm run test:reliability:soak`运行1000轮、每轮四个Query及周期CAS/幂等重试。原生PG另用一次性Docker夹具补验，不替代pg-mem质量指标。`eval:reliability:faults -- --source=<before> --output=<new-file>`对相同未结束驱动测四次请求及迟到后读取数量；不能用该机制结果冒充真实SQL硬取消。

`npm run eval:reliability -- --source=<before> --report-dir=<new-dir>`与当前`--compare=<before>/raw-report.json`对照：1k/10k、三轮、短/长值、提供并发1/4，Recall/Context/Query各自10次预热、100响应采样，共72行/7200响应。SQLite是同步单进程，不是SQL并行。原始响应投影、全部延迟、P50/P95/P99/max、busy/timeout/failed/invalid、让出延迟及RSS采样分开保存。禁止用总valid或RSS采样冒充语义质量/内存峰值。

正式测量前固定工程门禁：每workload三轮P95中位数≤参考中位数×1.5+0.5ms，少于三轮标未建立，不能事后调低阈值或删慢样本。它不是生产SLO；旧benchmark:lite及公共quality/baseline独立保留。完整网格、计数、原响应期望及百分位重算由测试校验；报告目录不覆盖旧证据。详见[5C设计](./retrieval-core/phase-5c-observability.md)。

## 阶段4B/4C：预算覆盖与证据答复专项

`npm run eval:answer -- --report-dir=<new-dir>` 独立输出quality/citations/security/stability/latency/packing-ablation及raw-report。10个完全虚构场景 × 四存储 × 三次重建形成120行，每题预热1次后同库重复5次；不是120个独立问题。固定预期覆盖无证据、超预算、部分/完整多问题、最小数量、显式冲突、历史未投影、权限确认及原值否定/条件。引用必须对齐实际Context的memory/event/version并重算hash，不用模型或新标注替代旧检索成绩。

faithfulness只报原值投影忠实性；语义生成回答的faithfulness、引用来源认证和模型prompt-injection抵抗均未实现/未评估。coverage只表示字面子查询匹配，不是语义answerability。packing-ablation用相同候选比较query_coverage/rank_only，保留预算覆盖失败；不称全局最优。安全分母按禁止夹具分别报告，原生PG工程与pg-mem质量分开。原public baseline/quality-v1失败仍保留，容量性能与Query新链路另测，不用小夹具延迟或benchmark:lite的普通Context代替Query性能。

`eval:answer -- --report-dir=<new-dir> --capacity`额外测SQLite 1k/10k干扰记录加两个独立主题的端到端Query（预算覆盖+引用），每容量三次建库，每操作预热10次后采样100次，原始延迟/P50/P95/P99/max及响应校验单独输出capacity.json。它与旧benchmark:lite是不同workload，不能互换数字；没有SLO或提速声明。

## 4A：Context选择机制

`npm run eval:context -- --report-dir=<new-dir>` 独立输出 quality/ablation/stability/latency JSON。8个固定虚构证据矩阵、每题5次技术重复，比较相同候选下的默认 relevance_first、禁用用途的 relevance_only 与旧 legacy_weighted。评分遵循事先写明的层级/名次约束，机制误选率不是实际查询的语义false injection；所有消融失败保留。`--source=<clean-before>` 可用同一评测器测旧实现，新增契约在旧实现不通过不是线上缺陷数量。

原公共质量仍由冻结标注的 `eval:baseline -- --compare=<before>/raw-report.json` 单独衡量，不能用机制8/8替代Recall/MRR、miss或false injection。跨存储接入测试与原生PG工程分别记录。小夹具延迟不代表容量或SLO，`benchmark:lite` 前后用相同源码基线/锁文件/机器/参数独立运行，保留慢样本。4A首次验收时未包含4B预算后覆盖与4C引用；当前两者已单独实现，结果见上方4B/4C报告，原值投影忠实性不等于模型语义faithfulness。

## 3C：显式事实专项与成本

`npm run eval:facts -- --report-dir=<new-dir> --capacity` 在独立 `fact-v1` 虚构声明夹具上输出 quality/security/stability/latency/raw-report 与可选 capacity，四存储与 Recall/Context 分开。8 个不同样例、3 次重建、5 次重复形成 192 行，不是 192 个独立问题。字面冲突、有效期、明确替代、原查询不匹配替代者、可见分区和旧数据控制各有固定标注；不改 `quality-v1` 或 `core-baseline-v1` 的原有失败。

`--source=<frozen-before>` 可记录旧源码不具备声明/回执的实际观察；`--compare=<before>/raw-report.json` 校验同评测器、数据、锁文件、Node 与完整网格并重算原始排名。旧源码的新契约缺失不是历史线上缺陷数；公共原基线收益另比，不能将新夹具通过包装成语义质量提升。稳定性区分同库排序重复与重建成员集合，未证明随机 UUID 全序。确认分母 0/0 仍是未覆盖。

容量专项 SQLite 1k/10k 各三轮，分别测 single_group 与 many_groups（每通道 50 个候选，最多 50 个不同组）；每操作预热 10 次、采样 200 次，全部慢样本保留。它衡量事实核实增加的成本，不与旧 `benchmark:lite` 或公共基线容量数字混比，也没有延迟 SLO。原生 PostgreSQL 工程与 pg-mem 质量仍分别记录。

## 阶段 3 首个增量：公共检索与信号消融

`eval:baseline -- --compare=<phase2>/raw-report.json --report-dir=<new-dir> --capacity` 在冻结的 core-baseline-v1 上比较公共 Recall/Context，保留各存储、质量、安全、稳定性与全部容量轮次。原始标注不变。结果见[本轮验证](./retrieval-core/phase-3-validation.md)。`eval:candidates -- --compare=...` 另证独立候选行为未退化。

`npm run eval:ranking -- --report-dir=<new-dir>` 输出独立 quality.json、ablation.json、stability.json。4 个固定虚构证据层样例检查 native order、exact tier、RRF 与 filter-only；关闭 BM25/Exact/RRF 时使用相同候选。RRF 专项两臂均关闭 exact tier，以隔离融合信号。它是机制消融，不是数据库质量或泛化成绩；当前/旧事实仍看原公共基线。全部样本/失败保留；无延迟 SLO 或统计提速结论。

## 阶段 2：候选召回独立报告

本节描述阶段 2 当时的独立交付；公共入口现由阶段 3 接入并另行验收，下列旧结果不改写为新结果。

`npm run eval:candidates -- --report-dir=/tmp/candidate-run --capacity` 测独立 Core 候选路径；公共 Recall/Context 的接入收益由阶段 3 另测。索引分别链接质量、安全、稳定性、小夹具延迟、BM25 消融与独立 capacity.json；各存储/通道/数据集分开，Structured 只统计过滤资格覆盖，不冒充问题相关性。历史结果与限制见 [2C](./retrieval-core/phase-2c-validation.md)。

2C 报告升级为 `open-continuity-candidates-v2`，增加原判定、实际观察、重复选择与覆盖清单；旧 v1 不能直接作为比较输入。`--compare=<reference>/raw-report.json` 校验同口径并逐题重算，拒绝缺行、伪造 pass、预算或标注变化；带 `--capacity` 时同时要求参考目录有匹配的 capacity.json，重算样本分位数，生成独立 capacity-comparison.json。延迟变化不会伪装成已存在的 SLO 门禁。本次证据采用持久目录而非临时目录，manifest 与[可移植摘要](../evals/baselines/retrieval-core-phase-2c.json)分开保存；数据标注未改，2C 未修改生产查询行为。

使用 `--mode=legacy --source=/path/to/frozen-phase-1` 测旧 lookup 的显式参考投影：Exact 对应旧 key 查找、Structured 对应旧 list、Lexical 对应旧整句命中过滤；它不是声称旧代码已存在新候选 API。小夹具先取完整候选再做可选确认筛选和 K 截断；超过 100 条即拒绝参考投影，不静默漏掉候选。新增能力的 Required 参考失败会非零退出，不能当作生产退化数量。

原 `core-baseline-v1` 仅在此按 Lexical 单通道测量，保持原 Recall 标注和 Required/Challenge；与公共融合指标不可混比。补充 `candidate-v1` 明确每题所属通道、确认策略和 SQLite 原生专项适用范围；fallback 不支持的专项失败逐项保留，不改为通过。无分母是未覆盖，不是零泄露。新数据只是工程回归夹具，无独立保留集，不证明真实查询泛化。

BM25 消融保留相同 SQLite 完整候选集合，关闭排序后先按时间/id 重排再截断 K；若完整集合超过 100 则报错。由此区分“字面多项 AND 改变候选集合”和“BM25 改变顺序”，不把这种消融耗时当生产性能。

容量 workload 为 SQLite 1k/10k 各三轮，每操作预热 10 次、采样 200 次；Exact、Structured、Lexical、短查询分别校验响应并保留 P50/P95/P99、全部原样本。与旧公共 `benchmark:lite`、旧 `eval:baseline --capacity` 是三个不同 workload，不能互换数字。没有性能 SLO，不以响应正确或某轮更快宣称无回归/提速。

## 分层内核基线

`npm run eval:baseline -- --report-dir=/tmp/core-baseline-run --capacity` 生成可重现的独立报告：召回、Context、安全、稳定性、容量性能、工程命令执行状态各有入口，四种存储分别展示，Required/Challenge 分开。用 `--source` 测干净旧 checkout，用 `--compare=<previous>/raw-report.json` 在完全相同的评测口径下逐样例比较；失败以非零状态退出。

规则与证据限制见 [baseline framework](./retrieval-core/baseline-framework.md)。新数据版本 `core-baseline-v1` 保留旧质量样例并扩充边界，不能与旧 `quality-v1` 总指标直接比较。`--capacity` 测 1k/10k SQLite，每容量三轮，先预热再保留 P50/P95/P99 和原始样本，并校验返回结果；它尚不是并发、故障恢复或性能 SLO 验证。工程可靠性报告不会伪称已经执行 `npm test`。

阶段 1 的存储正确性独立运行 `npm run test:storage`；通过 `OPEN_CONTINUITY_CONFORMANCE_SOURCE=/path/to/clean-checkout` 可用同一套新增契约测试测旧实现。新增契约要求与修复缺陷分别解释，不能把新增 API 缺失等价为线上故障数。pg-mem 不证明事务锁、真实回滚或保留 JSON 键；真实 PostgreSQL 测试需显式配置本地测试 URL，未配置会显示 skipped。评测器为标准 `strpos` 注册透明模拟函数后，必须重新生成同口径 reference，不能复用旧 evaluator hash 的报告。

`npm run test:storage:postgres:docker` 是显式的一次性真实 PostgreSQL 验收入口：本地 Docker context、loopback 随机端口、tmpfs、虚构夹具、结束后仅清理该实例。不默认启动服务，不读取现有数据库。本次 1B/1C 原生存储结果和质量/安全/稳定性/容量分别见 [补验记录](./retrieval-core/phase-1bc-validation.md)；质量 harness 仍为 pg-mem，不用原生工程通过结果替代原生质量评测。

OpenContinuity includes a reproducible synthetic benchmark for the local SQLite Profile. It is intended to detect regressions and establish an order-of-magnitude baseline, not to promise identical latency across machines.

Run the default workload:

```bash
npm run benchmark:lite
```

Choose a smaller or larger workload without modifying the script:

```bash
npm run benchmark:lite -- --memories=1000 --iterations=50
npm run benchmark:lite -- --memories=100000 --iterations=200
```

The benchmark creates a temporary SQLite database, writes obviously fictional records, measures exact-key recall, FTS recall, and Context Pack construction, prints machine-readable JSON, and deletes the database. It never opens the user's configured database.

The output reports the platform, architecture, Node.js version, database size, seed throughput, and p50/p95/max latency. Compare results only when the dataset, runtime, hardware, power mode, and storage conditions are comparable.

For a release baseline, record the command and raw JSON in the release notes or CI artifact rather than committing machine-specific results as a universal claim. Performance regressions should be investigated when a repeatable test on the same environment materially changes p95 latency or database growth.

Dense 质量验收在各出口计分前检查每次 Dense 调用，含 Query 最终打包前的调用；推理不可用、索引不完整和 Query deadline 拒绝作为正常负例得分。九项虚构回归与真实模型复测独立保存，涵盖推理失败、正常拒绝、OFF 不加载模型及初始化资源清理。生产 fail-open 和冻结标注/阈值保持。
