# 阶段 0 补强验证（2026-10-12）

## 比较来源

干净基线：`e23207aa9e746c71a599af8e2a0c913c5d59bf94`，源码 hash `f9cdac371022806f090714c52658983fe2074e55bfa5267e1131d78e60d54fe7`。

Spike：同一 HEAD 加未提交源码修改，源码 hash `df8a211f8e71eaaa1bd02d6326a4512d4f1a74a75bf805605b02782dab286b32`，不能将其行为归属为干净 HEAD。

两者使用评测器 hash `0c58e7da2c3c7a6e0caee446310184ad8fae0fc70536f28fe5c813fc2b345130`、数据集 hash `97f0018b83f8043bc9ec7986df1537dacc46c52801e8249fe0e4244ad7139152`、同一锁文件、Node `v24.20.0`。14 个 legacy Context 判断与 Required/Challenge 状态逐项核对未变；新增 6 个样例，共 20 个独立问题。轮次、存储、入口只增加观测，不增加独立问题数。

两次容量运行依次进行。原始报告在显式创建的临时证据目录，未加入仓库。[重现命令与独立查看入口](./baseline-framework.md)。

## 召回质量（SQLite）

| 样例组 | 指标 | 干净基线 | Spike |
| --- | --- | ---: | ---: |
| Required | 判断通过率 | 27/27 | 24/27 |
| Required | Recall@3 / MRR@3 | 100% / 100% | 100% / 100% |
| Required | False selection | 0/24 | 3/27 |
| Challenge | Recall@3 | 35.00% | 75.00% |
| Challenge | MRR@3 | 30.00% | 63.33% |
| Challenge | False selection | 6/21，28.57% | 21/48，43.75% |

Spike 的正例召回改善，但 `negative-no-evidence` 返回 unrelated；四种存储都产生这一 Required 失败。短查询、宽泛查询、多相关项的噪声也退化。逐存储结果独立保存，不平均成跨存储分数。

## Context 选择（SQLite）

| 样例组 | 指标 | 干净基线 | Spike |
| --- | --- | ---: | ---: |
| Required | 判断通过率 | 30/30 | 27/30 |
| Required | False injection | 0/24 | 3/27 |
| Challenge | Recall@3 | 11.11% | 44.44% |
| Challenge | MRR@3 | 11.11% | 44.44% |
| Challenge | False injection | 6/12，50% | 15/30，50% |

不同 key 的旧事实仍先被选择。当前事实/演化三个类别的判断为 6/9，不证明事实冲突解决能力。语义改写、跨语言、模型重排仍保留 challenge/未实现状态。

## 权限安全

四存储分别检查，两者都没有本次夹具中的 user/agent/task/private/Context-userConfirmed 泄露。每存储、每入口的 user、agent、task、private 各有 3 个禁止夹具暴露；Context userConfirmed 有 6 个。Recall userConfirmed 分母为 0，既有策略不强制确认，不能标作“已验证零泄露”。

有限夹具不覆盖完整权限组合、workspace 或真实 PostgreSQL。安全通过不能替代相关性正确。

## 排序稳定性

四存储、两入口各自：同库重复顺序 60/60 相同；重新建库顺序 20/20 相同。稳定地选错仍是质量失败，因此稳定性独立展示。等时间戳/UUID tie-break 的跨建库性质未覆盖。

## 容量性能与响应有效性

每容量 3 次建库，每操作预热 10 次后测 200 次，串行、同一台机器。三轮范围为描述结果，不构成生产 SLO。

| 容量 | 操作 | 干净 P95 范围 ms | Spike P95 范围 ms | 响应有效性 |
| --- | --- | ---: | ---: | --- |
| 1k | Exact | 0.134–0.140 | 0.136–0.170 | 两者通过 |
| 1k | FTS | 0.381–0.447 | 1.486–2.906 | Spike 每轮 200/200 含错误 topic |
| 1k | Context | 0.384–0.595 | 1.404–2.554 | Spike 每轮 200/200 含错误 topic |
| 10k | Exact | 1.897–2.321 | 2.025–2.579 | 两者通过 |
| 10k | FTS | 4.162–4.918 | 13.533–19.550 | 两者通过 |
| 10k | Context | 4.190–7.500 | 13.451–13.694 | 两者通过 |

输出必须包含指定 Topic 编号；无关返回不能用于宣称查询加速。原因与消融在 Retriever/排序阶段处理，阶段 0 未修改生产代码修复这些问题。

## 工程验证（当前工作区）

| 命令 | 结果 |
| --- | --- |
| `npm run typecheck` | 通过，评测器由测试引用纳入编译 |
| `npx vitest run test/core-baseline.test.ts` | 5/5 |
| `npm test` | 37 文件、151/151 |
| `npm run eval:suite` | 185/185，泄露 0/40；与其它工程测试并行，延迟不用于性能归因 |
| `npm run eval:quality` | Required 18/18；challenge 12/42；工作区旧口径，不与旧快照作因果比较 |
| `npm run benchmark:lite` | 完成；旧口径未校验响应，不替代新容量门禁 |
| 新基线，干净 checkout | exit 0；Required、安全、稳定性、容量响应通过；challenge 继续失败 |
| 新基线，Spike + compare | exit 1；负例 Required 失败、逐样例退化、1k 容量响应错误 |

比較器产生 144 个退化信号，包含四存储、双入口、三轮和多指标重复；不是 144 个独立失败问题。对应 4 个问题：short-query-high-overlap、broad-query-noise-control、negative-no-evidence、multiple-relevant。

## 验收状态

可运行、同口径、分层查看和回归阻断机制已实现；**探索性 Spike 未通过新门禁**。远端矩阵、真实 PostgreSQL、保留验证集及并发/故障性能仍未验证。生产质量门禁是显式 `eval:baseline`，尚未接成远端 CI 必过项；CI 中的 `npm test` 会检验评测器自身。

新增代码均在评测/测试层；既有 Spike 原样保留。没有 commit 或 push。
