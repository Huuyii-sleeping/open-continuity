# Retrieval Core 阶段门

任何阶段都必须独立完成设计、实现、验证和复盘。上一阶段未通过，不进入下一阶段；不能通过一次大改后的总指标反推每一层都正确。

## 每阶段必交证据

报告必须拆分召回、Context、安全、稳定性、容量性能和工程可靠性；不同存储独立、Required/Challenge 独立。没有综合总分。未执行的维度标为未验证，禁止用其它维度的通过结果替代。

1. **职责**：本阶段解决的问题和明确非目标。
2. **契约**：输入、输出、错误、能力版本和兼容策略。
3. **不变量**：user、agent、task、private、userConfirmed、workspace 和审计边界。
4. **变更范围**：修改文件及其所属层，说明为什么没有跨层实现。
5. **测试**：单元、契约、安全、失败和迁移测试。
6. **质量**：阶段对应指标的前后对比。
7. **消融**：关闭新增机制后的结果，用于证明收益归因。
8. **性能**：P50/P95/P99、容量、超时和环境说明。
9. **失败样例**：逐项保留，不通过降标或硬编码抹掉。
10. **能力声明**：implemented、fallback、challenge、roadmap 的更新。
11. **剩余风险**：进入下一阶段前仍接受的风险及理由。
12. **人工确认**：只有评审确认后才开始下一阶段。

## 阶段 1 准入条件：可信存储内核

阶段 1 可以开始，但只允许处理存储职责。进入阶段 2 前必须满足：

- 明确 Storage Contract 是否保留 query 语义，或拆分成纯存储原语。
- InMemory、SQLite、PostgreSQL、JSON 的语义矩阵经评审确认。
- shared conformance suite 覆盖 InMemory。
- 覆盖过滤、稳定分页、幂等冲突、CAS、事务回滚、Forget/History 和迁移。
- 明确 legacy cursor 的跨过滤器兼容策略。
- PostgreSQL 的能力声明与实际实现一致，并区分 pg-mem 与真实环境证据。
- 阶段 1 不引入 BM25、RRF、Embedding、Rerank 或 Answer 行为。

## 阶段 2 准入条件：候选召回

- 每个 Retriever 能独立产生候选并输出明确来源。
- 权限过滤发生在候选返回之前。
- Exact、Structured、Lexical 的职责没有重复计算。
- 每个 Retriever 单独报告 Recall@K、miss rate、P95 和泄露率。
- SQLite 的 FTS5/BM25 与短查询 fallback 分别有确定性测试。
- 不进行跨通道融合，不生成 Answer。

## 阶段 3 准入条件：排序与事实选择

- Evidence Contract 区分 raw score、score model、score direction、channel rank 和 fused score。
- 单 Retriever 直接使用原生排名；多个独立排名才允许融合。
- Exact precedence、boost 上限、RRF 参数和 tie-break 均有契约。
- 新增每个排序信号都有消融实验。
- 报告 MRR、nDCG@K、排序稳定性和当前/旧事实选择准确率。
- 排序版本进入 cursor fingerprint 或有明确兼容演进方案。

## 阶段 4 准入条件：Context 与 Answer

- Recall、Context、Answer 是独立消费者，不共享隐式策略。
- Context 明确 public、userConfirmed、workspace 和预算语义。
- Answer 只使用 Evidence Contract，不能直接扫描 Store。
- 证据不足时有明确 partial/insufficient/abstain 行为。
- 报告 false injection、重复注入、faithfulness、引用覆盖和拒答准确率。
- 所有安全泄露率保持为 0。

## 阶段 5 准入条件：运行可靠性

- 5A/5B/5C独立设计与验收，复用已验证存储/检索，不引入新Adapter或模型。
- 同一请求共享单调deadline；超时不再发新读取；未结束驱动工作仍占槽位。
- 无命中、超时、容量忙碌、存储失败分别可辨；不自动重试未知提交。
- 明确同步SQLite、自定义驱动、关闭drain的边界，不声称硬取消或断电认证。
- 真实进程并发、事务边界退出、幂等重试、版本/FTS/引用及备份恢复独立验证。
- Recall/Context/Query容量与并发原样本分开；固定性能回归规则在测量前声明。
- 原质量标注/Challenge和scope/private/确认边界保持，不用工程成绩替代语义提升。

## 阶段报告模板

```text
阶段：
基线提交 / 实现提交：

目标：
非目标：

契约变化：
修改范围：
不变量检查：

测试结果：
质量前后对比：
消融结果：
性能前后对比：

失败样例：
能力声明：
剩余风险：

结论：通过 / 不通过
进入下一阶段：是 / 否（需要人工确认）
```
