# 7A模块化内核：最终审查与详细测试

本次以模块化可维护性、独立线路和失败边界为验收目标。完整阅读实现与既有测试后，发现并修复两个契约漏洞：无效评分/批次状态仍可被接受，分项报告会忽略文件跳过与断言已执行的矛盾。新增反例在修复前3项失败，修复后对应151项回归通过。

2026-10-27，macOS arm64 / Node24.20.0 / npm11.19.0。结论：当前模块化基础达到继续下一增量的验收条件；本轮详细测试通过，原质量保持。该判断不表示完整语义RAG、生产身份认证或企业部署已经成熟。

工程、召回/Context/Query、排名/事实/引用、权限、稳定性、故障恢复与容量分别复测，不合成总分。不改变标注/阈值，不接入模型，不读取用户真实历史/默认数据库，也不提交推送。

## 审查结论与范围

本次“足够完善”的判断范围是模块化基础：主要职责有实现/契约入口，可单独运行和定位测试；管道负责调度，事务、请求scope与Context预算仍有明确所有者。没有把必要协作拆成网络微服务，也不要求每个helper成为独立部署组件。

- Core/Storage边界180源码、685引用，0违规；静态运行时import/export图231源码、518边，排除纯类型边后无循环。字面引用检查不证明任意动态运行时依赖完全不存在。
- 检查独立Reader注册、旧facade override、排名/事实/分页与消费者窄契约；三种Context选择策略互不导入。
- 检查SQLite/PG原事务、CAS、幂等和恢复，JSON只兼容；不复制其它工作区内容，不改Adapter。
- 检查共享deadline、迟到工作保留槽位、关闭drain，以及Context完整值/预算/引用和拒答边界。
- 修复无分数模型/方向、未知status/非boolean截断和not-run有命中的非法批次；违反原契约明确返回`STORAGE_ERROR`，有效候选排名及cursor配置不变。
- 修复测试文件skipped/pending与已执行断言矛盾的报告。新增3个反例修复前失败，修复后151项受影响测试通过，未用降低标准消除失败。

## 工程复测

| 检查 | 结果 | 证据边界 |
| --- | --- | --- |
| `release:check` | 通过 | typecheck、完整测试、suite/quality、生产依赖audit、pack与实际安装smoke |
| 完整测试：正常顺序 | 621通过、59跳过 | 127文件通过，1条件文件跳过 |
| 完整测试：seed270027打乱顺序 | 621通过、59跳过 | 第一次顺序扰动 |
| 完整测试：seed270028打乱顺序 | 621通过、59跳过 | 第二次顺序扰动，不把三轮算作1863独立测试 |
| 分模块结果 | 17分组、103测试线路，529通过、59跳过 | 55主要职责映射；分模块范围不同于完整测试 |
| `test:storage` | 94通过、59跳过 | 独立存储契约入口 |
| 原生PostgreSQL | 17.11，58/58 | 一次性loopback/tmpfs虚构夹具，清理已确认 |
| 两组1000-cycle soak | 通过 | 原进程恢复与Capture持续重复测试；不新增真实客户端验证 |
| 游标/兼容 | 两策略×两查询，6次双向续页；27非命令入口84原导出保留 | 同一虚构SQLite，比较全部响应，排除但校验自然评估时间 |

59项条件跳过中58项已由原生PG另行执行；剩下1项为既有pg-mem JSON key限制，保持partial，不静默改成通过。未触发远端CI、PR或发布。

## 质量、机制与安全

| 独立评测 | 结果 | 可以证明什么 |
| --- | --- | --- |
| golden-v1 | Capture7题、Injection4题；记录的精确率/召回率均1，安全泄露0/5 | 小虚构样本，仅基线口径 |
| suite-v1 | 185/185，安全0/40 | Capture/Injection/治理五轮回归 |
| quality-v1 | Required15/15、Challenge9/42；安全0/6，false injection0/6，miss21/36 | 旧语义Challenge保留，重复观测不是独立问题数 |
| 公共基线前后 | 480记录，所有非延迟统计完全相同 | 同数据集/同评测器/各存储和入口独立比较 |
| 候选专项 | 420记录，Required/安全/稳定门禁通过 | Exact/Structured/全文候选独立；PG质量为pg-mem |
| 排名消融 | 4个机制案例通过 | 排名、Exact优先、Structured零贡献与融合信号 |
| 事实专项 | 192记录通过 | 显式声明、可见组、有效期/替代/冲突和拒绝边界 |
| Context机制 | 默认8/8；relevance-only7/8、legacy3/8原样保留 | 独立策略消融，失败模式没有重标通过 |
| 原值Answer | 10个虚构案例、120重建记录，门禁通过 | 值保留、版本引用、覆盖和拒答，不是模型语义faithfulness |
| 分层诊断 | 1368记录，门禁通过 | 逐题候选/排名/预算/事实/策略观察；已暴露验收不是盲测 |

公共基线SQLite Recall@5=0.6765、MRR@5=0.6471、miss0.3000；Context Recall@5/MRR@5=0.5882、miss0.3889，前后不变。其它存储/入口、各K/nDCG和逐题分母保留在分项原报告中。

该基线包含Challenge：SQLite Recall false selection6/48、Context false injection6/39，不与quality-v1负例的0/6混为一个数字。各存储/入口user/agent/task/private暴露0/3，Context确认边界0/6；Recall允许未确认，确认分母0，不能当作确认零泄露。Workspace由既有Adapter/Injection实施，不是该Core基线新增覆盖。

各组同库重复稳定60/60、重建稳定20/20、当前事实选择6/9，全部保持。相同时间戳+随机UUID跨库稳定、未声明语义冲突和真伪仍未得到证明。

## 故障与来源

前后同一未结束假驱动测试：第一请求timeout，随后三请求RUNTIME_BUSY；实际读取只启动1次，真正settle后pendingReads=0并恢复completed。不能由此声明SQL硬取消或跨实例统一容量控制。

Before为本轮开始完整工作区源码，包含此前未提交6/7A内容，不是纯HEAD。Before `src/`SHA-256：`b3f5d3392e0c44beaa3fa5f202659bf7a3a63c5531be01ee37c9cfa28aecb49e`；After：`28a4a9aa1892688d87ae3863f2183d710c4eabfc1b6a254cf92fef0a641797ca`。使用同一lock、当前评测器和旧标注。原始源码/日志/JSON报告位于仓库外，不加入提交；最终文件范围与指纹另核对。

## 容量、延迟与错误率

`eval:reliability`：SQLite、同机单进程，1k/10k数据、两种完整值长度（record-repeats1/16）、三入口、提供并发1/4、三轮、每轮预热10次并测100请求。72个workload、7200请求全部completed；busy/timeout/failed/invalid均0。长值/多查询的完整Context预算与版本引用另校验。

下表是三轮P95的中位数（ms），各数据长度独立；并发4是同时提供4个请求，不是4个独立SQL线程：

| 数据量 | 值重复数 | 入口 | 并发1 | 并发4 |
| --- | --- | --- | --- | --- |
| 1k | 1 | Recall | 0.405 | 1.167 |
| 1k | 1 | Context | 0.424 | 1.355 |
| 1k | 1 | Query | 0.725 | 2.287 |
| 1k | 16 | Recall | 0.400 | 1.143 |
| 1k | 16 | Context | 0.467 | 1.258 |
| 1k | 16 | Query | 0.689 | 2.346 |
| 10k | 1 | Recall | 2.440 | 10.693 |
| 10k | 1 | Context | 2.693 | 10.080 |
| 10k | 1 | Query | 5.114 | 19.851 |
| 10k | 16 | Recall | 2.512 | 9.781 |
| 10k | 16 | Context | 3.046 | 10.372 |
| 10k | 16 | Query | 5.012 | 19.189 |

这个容量命令没有Before参考，因此响应有效性通过，性能比较门禁未建立。保留各轮P50/P95/P99/max、原样本、RSS和yield lag，不将该表当作生产SLO或全存储性能承诺。

`benchmark:lite`另做三轮10k/100前后配对，顺序Before→After、After→Before、Before→After，全部其它测试结束后串行执行。沿用预先设定回归预算`After P95中位数≤Before×1.25+1ms`，每轮P95：

| 轮次/版本 | exact-key Recall | FTS Recall | Context |
| --- | --- | --- | --- |
| 1 Before | 1.839 | 3.403 | 3.323 |
| 1 After | 1.780 | 3.722 | 3.279 |
| 2 Before | 1.702 | 3.387 | 3.230 |
| 2 After | 1.692 | 3.249 | 3.487 |
| 3 Before | 1.729 | 3.338 | 3.810 |
| 3 After | 1.708 | 3.269 | 3.289 |

三轮P95中位数exact1.729→1.708、FTS3.387→3.269、Context3.323→3.289，均满足预算。较慢轮次原样保留，不能将小幅波动解释为稳定提速；此次生产改动是非法证据拒绝，不是检索算法优化。

## 未通过项与限制

拼写消融工程完整性通过，默认启用接受仍失败：6个合法词题目/入口退化保留；10k broad-probe ON三轮P95中位数3.3938ms，门槛2.5191ms，成本失败保留，继续OFF。Context其它策略消融中的失败和旧quality语义Challenge也没有重标。

本轮没有新增Embedding、跨语言/语义reranker、SQL硬取消、用户OAuth/多租户认证、生产SLO或真实客户端验证。PG保持preview/substring fallback，JSON保持兼容。职责登记覆盖主要责任、不穷举每个helper或分支；测试通过不等于没有未知缺陷。

必要事务、执行scope和预算共享状态继续保留，避免拆分成各自提交或重复计费。静态依赖检查、单元契约、跨模块集成与质量评测分开解释；报告可定位观察失败线路，仍需排查上下游才能定位根因。

## 执行命令

```bash
npm run release:check
npm test -- --sequence.shuffle --sequence.seed=270027
npm test -- --sequence.shuffle --sequence.seed=270028
npm run test:core -- --report-dir=<仓库外新目录>
npm run test:storage
npm run test:storage:postgres:docker
npm run test:reliability:soak
npm run test:soak
npm run eval:golden
npm run eval:suite
npm run eval:quality
npm run eval:baseline -- --source=<before-source> --report-dir=<baseline-before>
npm run eval:baseline -- --report-dir=<baseline-after> --compare=<baseline-before>/raw-report.json
npm run eval:candidates -- --report-dir=<candidates>
npm run eval:ranking -- --report-dir=<ranking>
npm run eval:facts -- --report-dir=<facts>
npm run eval:context -- --report-dir=<context>
npm run eval:answer -- --report-dir=<answer>
npm run eval:diagnostics -- --report-dir=<diagnostics>
npm run eval:reliability:faults -- --source=<before-source> --output=<fault-before.json>
npm run eval:reliability:faults -- --output=<fault-after.json>
npm run eval:lexical -- --report-dir=<lexical>
npm run eval:reliability -- --report-dir=<reliability> --sizes=1000,10000 --rounds=3 --samples=100 --concurrency=1,4 --record-repeats=1,16
npm run benchmark:lite -- --memories=10000 --iterations=100
```

Lite命令分别在Before/After执行三组；命令与原始退出状态保留journal。候选/事实/Answer的额外大容量专项未重复启用`--capacity`，本轮大型负载由独立三入口reliability与Lite承担，不能替代更大注释事实库、不同索引布局或生产环境验收。没有commit/push/PR/远端CI。
