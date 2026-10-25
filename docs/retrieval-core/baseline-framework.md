# 可执行基线与分层结果

## 定位与证据等级

阶段 0 首次交付是审计快照。现补充可重复运行、验证指标计算、检测逐样例退化的基线机制。旧 `quality-v1` 数字原样保留；新口径使用独立版本 `core-baseline-v1`，禁止直接把不同口径的总指标做前后比较。

本机制是持续验收入口。它不是“成熟 RAG 已通过验收”的证据：当前样例覆盖、真实 PostgreSQL、并发/故障工作负载与保留验证集仍有明确缺口。新增生产机制必须补其对应评测，而不是仅在这 20 道题上调参。

## 结果独立查看

| 结果 | 独立入口 | 解释 |
| --- | --- | --- |
| 召回质量 | `recall/<backend>.md` / `.json` | Recall@1/3/5、MRR@K、nDCG@K、miss、误选与逐样例顺序 |
| Context 选择 | `context/<backend>.md` / `.json` | 消费者确认策略、预算后的选择质量；false injection 不冒充召回指标 |
| 权限安全 | `security/<backend>.md` / `.json` | user、agent、task、private、userConfirmed 各自分子/暴露数 |
| 稳定性 | `stability/<backend>.md` / `.json` | 同库重复和重新建库分别测量 |
| 容量性能 | `performance/README.md` + `size-*/run-*.json` | SQLite 1k/10k、每容量三轮、原始耗时和响应校验 |
| 工程可靠性 | `engineering/README.md` | 独立运行工程命令；未执行就写未执行 |
| 回归比较 | `comparison/<endpoint>-<backend>.json` | 每种存储、每个入口独立的退化与差值 |
| 来源与门禁 | `manifest.json` / `gate.json` | 配置、指纹、未覆盖项与门禁明细 |

InMemory、SQLite、JSON、PostgreSQL-pg-mem 分开报告，不平均成“跨存储总分”。各质量报告内 Required 与 Challenge 分开。总览只链接这些结果，没有综合总分。`raw-report.json` 仅供机器比较，不作为人读的入口。

## 重现与比较

在装好依赖的工作区运行；`--source` 指定被测源码，`--dataset` 指定本评测器拥有的固定输入。被测旧 checkout 也需按其锁文件安装依赖。

```bash
npm run eval:baseline -- --source=/path/to/clean-checkout --report-dir=/tmp/core-reference --capacity
npm run eval:baseline -- --source=/path/to/candidate-checkout --report-dir=/tmp/core-candidate --compare=/tmp/core-reference/raw-report.json --capacity
```

输出目录必须尚不存在，报告以 owner-only 权限生成，不覆盖旧证据。测试和评测使用明显虚构的数据以及独立临时数据库；清理仅删除本次创建的临时数据库，输出证据保留在调用方指定目录。报告、数据库和日志不自动加入仓库。

不运行 `--capacity` 时性能状态明确为未运行。仅测 SQLite 可使用 `--backends=sqlite`；它不能与四存储报告比较。`--output` 是兼容的单个 JSON 输出，推荐人读方式始终为 `--report-dir`。

## 标注与指标协议

- 原基线提交 `e23207aa` 的 14 个 Retrieval 样例，其 Context 判断与 Required/Challenge 状态全部保留。新增 6 个身份、安全、负例与多相关项样例，组成 20 个独立样例。
- 现有 Recall 不强制 userConfirmed，独立 `recallExpected` 明确表达这一政策。原 unconfirmed paraphrase 样例的 Recall 单独标为 challenge：保留“应找回语义相关项”的挑战，不能把“不支持改写”算通过。Context 的原判断和门禁不变。
- 默认二值相关性；多相关项样例增加明确等级（直接证据 2、辅助证据 1）。nDCG 使用 `(2^grade - 1)/log2(rank + 1)`；不同版本的标注不得混用。
- 负例不进入 Recall/MRR/nDCG 的正例分母，但其误选进入 false selection/injection。分母为 0 返回 `null`，人读显示“未覆盖”，不能记作 0% 泄露或 100% 通过。
- Recall@K、MRR@K、nDCG@K 是正例样例的宏平均；miss 是漏掉相关标签数/相关标签总数；false selection 是所有不相关返回数/所有返回数，包括 forbidden、unknown。重复项不能增加 recall 或 gain，且独立报错。
- 安全分母是每类禁止返回的夹具暴露数；没有返回不相关结果不意味着具备相关性。普通 Recall 的 userConfirmed 不作为访问控制，Context 的确认过滤独立报告。
- 查询异常、种子写入异常不能被移出分母；它们产生失败观测并阻断门禁。报告只输出错误类别，不输出可能含路径或数据的驱动错误正文。
- 三轮重新建库，每个请求预热一次并测量三次；写入间隔 2 ms 固定相对时间顺序。三轮是技术重复，不是 60 个独立问题，也不构成统计泛化结论。

## 回归门禁与指标自测

比较必须一致：数据集字节指纹、评测器源码指纹、K/预算/轮次/存储集合、锁文件与 Node 版本。源码指纹允许变化，报告包含实际源码 hash 和 commit，避免把 dirty Spike 误标成该 commit 的干净实现；运行中源码变化会使评测失败。

逐样例比较 Recall/MRR/nDCG、误选、原本通过的判断、事实值与版本、安全泄露及稳定性；不允许一个类别的收益掩盖另一类别的退化。Required 失败、运行异常、任何观测泄露、重复查询或跨建库顺序不稳阻断本次门禁。容量工作负载返回为空或返回错误 topic 时校验失败，不能用错误响应宣称提速。

`test/core-baseline.test.ts` 用可手算排名验证指标；覆盖 forbidden/unknown、重复项、零分母、矛盾标注、缺失观测、口径漂移、人工注入退化，以及分层报告不混入安全/性能字段。普通 `npm test` 会运行这些评测器完整性测试。生产质量门禁是单独 `eval:baseline`，不以单元测试通过替代。

## 当前覆盖缺口与扩充规则

- 20 个问题是确定性回归集，没有独立的盲测/保留集；不得据此宣称真实用户查询泛化。原 short-query 等样例的意图信息并不充分，保留为 legacy challenge，不能作为唯一排序优劣依据。扩充数据需加入明确问题、证据与标注理由，并创建新数据版本。
- 真 PostgreSQL、网络故障、死锁、崩溃恢复、冷启动、读写竞争未由此 harness 验证；pg-mem 不能代替这些证据。
- 存储过滤/分页/CAS/事务/幂等/迁移依据工程测试，阶段 1 需要统一并扩充契约矩阵。当前质量 harness 不覆盖所有组合。
- Workspace、Hook fail-open、Capture 生命周期由 Adapter Suite 负责；本内核安全报告明确不覆盖。Answer 尚未实现，faithfulness 与引用准确率不能填成通过。
- 每个通道的 Recall、原始 score/rank 证据与消融属于阶段 2/3；当前 harness 测量公开 Recall 与 Context，不能凭它定位所有通道内部原因。
- 三轮容量测试覆盖 1k/10k 串行 SQLite。P99 为样本描述，性能预算/容忍幅度需受控硬件与重复负载确定，尚未自动判定性能退化。不要把性能门禁“未验证”写成通过。
- 远端 Ubuntu/macOS × Node 22/24 尚未执行新基线。阶段 0 的成熟度必须由这些覆盖逐项提高，不能靠改状态标签完成。
