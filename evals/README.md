# 多轮评测套件

这里存放完全虚构、可重复运行的效果评测，不读取用户真实历史对话。它和 `test/` 的职责不同：工程测试验证接口、权限、异常和数据一致性；评测套件验证 Capture 记忆筛选、Inbox 治理和 Injection 选择质量。

运行：

```bash
npm run eval:golden
```

正式多轮门禁：

```bash
npm run eval:suite
```

`golden-v1` 是快速冒烟集；`suite-v1` 是正式评测集。正式集包含 18 个 Capture 场景、13 个 Injection 场景和 6 个治理场景，每个场景独立重复 5 轮，每轮都会创建并销毁自己的临时数据库。因此当前一次正式评测包含 185 次断言，不是对单个样例的重复执行。

另外提供 `quality-v1` 检索质量挑战集：它包含高相似短查询、近重复表达、同义改写、错别字、否定语义、跨语言、关键词干扰、冲突替换、JSON merge、时间新旧冲突和相似记忆权限边界等场景。每个场景独立重复 3 轮。它将场景标记为 `required` 或 `challenge`：`required` 是当前版本的稳定门禁，`challenge` 用于暴露尚未实现的语义检索能力，不能因为挑战集未全通过而降低基础门槛。

运行：

```bash
npm run eval:quality
```

`quality-v1` 会同时报告总通过率、required/challenge 分层通过率、按类别通过率、普通质量误注入率/漏召回率、安全泄露率和延迟。普通无关内容误召回属于质量指标；private、未确认或策略禁止内容被选中才计入安全泄露率。当前 Lite 版本是确定性 trigram/全文检索，不包含向量语义、跨语言 embedding 或 reranker，因此挑战集中的语义改写、错别字和跨语言场景可能失败；这正是后续升级检索层时需要持续追踪的基线。

套件只有在以下条件全部满足时才返回成功：

- Capture、Injection、治理场景通过率均达到 100%；
- private、未确认、workspace 禁止等记忆的安全泄露率为 0；
- Injection P95 延迟不超过数据集定义的 200ms 门槛；
- 没有任何失败场景。

评测使用 TypeScript 源码运行；如果要验证发布产物，还应先执行 `npm run build`，再运行真实 Trae Hook smoke test。

评测输出 JSON，主要指标包括：

- Capture candidate precision/recall：候选提取是否抓到应沉淀的显式记忆，是否把普通闲聊或敏感内容误提取。
- Capture sensitive block rate：虚构敏感样例是否被脱敏并阻断候选。
- Injection precision/recall@K：注入的记忆中有多少相关，以及相关记忆有多少被命中。当前 K 由 Injection 的 `maxMemories` 配置约束。
- false injection rate / miss rate：无关记忆误注入和相关记忆漏注入。
- security leakage rate：private、未确认或 workspace 不允许的记忆被注入的比例，目标是 0。
- latency p50/p95/max：从 Hook 调用到结果返回的本地端到端耗时。

正式套件还会报告：

- 每个场景、每一轮的通过/失败结果和失败详情；
- Capture、Injection、治理三类的独立通过率；
- P50/P95/P99/max 延迟；
- 失败场景 ID 和安全泄露场景 ID。

数据集只包含虚构项目、虚构偏好和虚构凭据占位符。扩展数据集时，应增加正例、负例、冲突偏好、跨轮证据和敏感字段覆盖，并保持 expected 标注可人工解释。新增场景必须说明期望行为，不能为了让指标通过而降低门槛。
