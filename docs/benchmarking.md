# Lite benchmark

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
