# 阶段 1B：写入、事务与恢复

本页只讲存储写路径；[1C](./phase-1c-pagination.md) 单独讲分页、权限与能力声明。阶段 1 的首次结果保留在 [历史验收](./phase-1-validation.md)，本次长任务的命令与质量/性能结果见 [补验记录](./phase-1bc-validation.md)。没有进入阶段 2。

## 已有实现

四条路径统一逻辑身份、幂等冲突、版本/CAS、确定性 JSON merge、Remember/Forget/History。请求与返回对象是独立副本，不把调用方对象留在存储内部；这里的对象快照不是数据库 snapshot isolation。

SQLite 的 current、event、FTS 在同一写事务内；JSON 兼容 ledger 通过校验和原子 rename 发布；PostgreSQL 先锁请求身份再锁逻辑记忆身份，避免首次创建、重复请求与 merge 的竞争。已有事务不是本次才发明的，本阶段是补齐一致性与失败证据。

## 本次复现并修复

### 回滚本身失败

故障用例在写入失败后再让 ROLLBACK 失败。修复前，Remember/Forget 直接抛出原驱动错误，并正常释放状态不确定的连接。

现在返回不含驱动正文的 `STORAGE_ERROR`，通过 `release(true)` 丢弃连接，不将未知事务状态交给下一个请求。迁移故障同样处理，初始化失败后仍可重新尝试。自定义 `DatabasePool` 包装器必须将 release 的 destroy 参数传给底层连接池；旧的无参数包装器在类型上兼容，但不能因此声称完成连接丢弃。

协议测试分别覆盖 Remember、Forget、Migration。真实 PostgreSQL 再验证：事件写入失败且 ROLLBACK 失败后，关闭连接使未提交事务终止；下一次连接看见旧状态，原请求键仍能成功重试。这不是断电或整个服务崩溃恢复证明。

### 遗忘事件不能充当写入回执

新增 `null` 值用例复现了 SQLite 的问题：拿 Forget 的幂等键发起字段相似的 Remember，原实现可能返回 `duplicate=true` 和遗忘事件。实际状态没有复活，但回执错误。

现在先检查 `event_type=memory_remembered`，其他事件一律返回 `IDEMPOTENCY_CONFLICT`。同一断言在四条路径及原生 PostgreSQL 执行，不改变 Remember/Forget 的授权范围。

## 恢复验收

- JSON/SQLite 关闭并重新打开；InMemory 从导出 ledger 重建；PostgreSQL 用新 Store 访问相同隔离 schema。检查 merge 原回执、Forget 的幂等占用、历史完整性和新生命周期的新 memoryId。
- 原生 PostgreSQL 验证并发 merge 的完整 version/supersedes 链、同请求重试以及 CAS 首次创建竞争。
- 原生 PostgreSQL 验证写入失败、遗忘删除失败、迁移 DDL 失败时，物化状态与事件/迁移标记真实回滚，并可重试。
- 模拟 COMMIT 已成功、驱动却丢失成功回执：首次返回错误；使用**原幂等键**重试取回原回执，历史只新增一次。不是自动重试未知结果，也不是实际网络断线实验。
- 原生 PostgreSQL 验证 future schema 在开启/关闭自动迁移时都拒绝，数据不变。

共享契约每条路径 18 个用例；InMemory、JSON、SQLite 各 18/18；pg-mem 17/18，保留 JSON 键的模拟器限制仍明确 skipped。原生 PostgreSQL 的全部 26 个用例（18 共享 + 8 原生专项）在三次新建实例中均通过；重复轮次不是 78 个独立场景。

## 独立重现

```bash
npm run test:storage
# 显式选择一次性真实数据库，需要本机 Docker：
npm run test:storage:postgres:docker
```

默认测试不自动启动服务、不安装新的 runtime 依赖。Docker 入口只接受本地 Unix/npipe context；新建随机命名、带所有权标签的实例，随机测试密码、loopback 随机端口、tmpfs 数据库，不挂载用户目录或复用现有数据库。结束时仅清理该实例；清理失败会报告且非零退出。首次执行可能需要下载官方 postgres 镜像；这不是产品的默认依赖。

也可继续使用显式 `OPEN_CONTINUITY_TEST_POSTGRES_URL`，只允许 loopback、`open_continuity_test*` 名称及随机测试 schema。不要使用用户现有数据库。Docker 不在 PATH 时通过 `OPEN_CONTINUITY_TEST_DOCKER_BIN` 指定可执行文件。

## 尚未证明

JSON 的断电耐久性与陈旧锁恢复、真实服务器重启/断电、分布式部署、跨平台/PG 版本矩阵、长期高并发与性能 SLO 未验证。PostgreSQL 仍为 Team preview；原生存储测试通过不能替代整个 Team 服务的发布验收。
