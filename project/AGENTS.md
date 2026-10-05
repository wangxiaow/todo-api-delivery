# 项目工作规则

## Global Kernel（随当前 Slice 刷新）

- 产品目标与 Contract 摘要：Todo HTTP API，支持新增/查询/修改/删除，数据持久化到本地 SQLite 文件，
  提供文档化启动方式与自动化验收。权威来源：`.agent/CONTRACT.yaml`（v1，status frozen）。
- MVP 范围与明确排除：in scope = 本文档所在工程的 `src/`、`migrations/`、`scripts/`、
  `tests/acceptance/driver`、`tests/harness`、`ci/verifier.yaml`；out of scope = 浏览器界面、
  组织/角色权限模型、外部通知投递（见 Contract 的 out_of_scope）。
- Critical Rules：BR-AUTHN（未认证不得读写）、BR-AUTHZ（跨所有者按 id 访问拒绝且零变化）、
  BR-VALIDATION（非法输入零持久化副作用）、BR-IDEMPOTENCY（同 key 只产生一个待办项）、
  BR-DURABILITY（重启后已提交写入仍在、被拒绝写入零部分结果）、BR-SECRET（错误响应不泄漏凭据/SQL/堆栈）。
- 当前 Baseline：尚无。`refs/heads/baseline/main` 由 Promotion 作业推进；本地诊断的 PASS 不是 Evidence。
- 当前 Slice：S1——Todo 垂直切片：Bearer 边界内的增删改查 + SQLite 持久化 + 可观测启动。
  注意：`.agent/slices/S1.yaml` **尚不存在**（bootstrap 窗口在写 Contract 后关闭，见「阻塞」），
  因此 `verify.mjs --slice S1` 与 `ci-record --mode precheck` 在跑任何门之前就会失败。
  该文件的完整内容在迭代日志的交接说明中，需要 Owner 或重新打开 bootstrap 窗口后落盘。
- 当前代码约定及来源 revision：
  - 数据访问与事务：所有写操作走 `src/db.mjs` 的 `withTransaction`（`BEGIN IMMEDIATE`）；迁移只在
    `src/migrations.mjs` 中按 `migrations/*.sql` 文件名顺序执行
  - 身份与授权：凭据映射只在 `src/auth.mjs` 解析；每个资源操作在 `src/domain/todos.mjs` 中先校验
    `owner_id` 再读写，跨所有者一律按 `not_found` 处理
  - 错误处理与日志：错误一律经 `src/errors.mjs` 的 `AppError` 构造固定信封；日志只经 `src/logging.mjs`
    输出单行 JSON
  - 目录与模块：`src/` 运行时代码；`scripts/` 门禁与构建；`tests/harness` 执行并记录结果；
    `tests/acceptance/driver` 只观测不判定；`tests/acceptance/spec` 是受保护标准
  - 命名与状态：HTTP 错误码使用 snake_case 常量；`version` 从 1 开始且每次成功写入自增 1
  - 共享抽象：HTTP 路由与请求体读取集中在 `src/http/`，领域层不接触 req/res；配置只在 `src/config.mjs`
    读取环境变量

## 执行规则

1. 开始或恢复工作先运行 resume，读取当前受保护 Contract、Acceptance、Baseline 和 CI 失败记录。
2. 只推进当前 Slice；产品语义未知时记录 unknown，不能猜测后当作既定事实。
3. 遵循代码约定，优先复用已有授权、数据访问与错误处理入口；HOW 决策在 STATE 记一行。
4. 变更先回答三问：是否改变 Journey 结果、Critical Rule 主体/资源/操作、in/out-of-scope；
   任一为是就提交 Change Proposal，暂停受影响实现等待明确授权。
5. 不删除 Required 义务，不降低断言，不 skip/only 必需 case，不自行缩小验收执行范围。
6. `tests/acceptance/spec` 只依赖 `tests/acceptance/driver` 的语义接口；driver 不得加入
   expect/assert、伪造结果或把异常转成成功。
7. 本地 PASS 用于诊断；每个 Candidate 由外部 CI 验证当前 Slice、全量 Spine、适用 Critical Rules
   和必要环境。
8. Candidate 的代码、标准、验证配置、依赖、迁移、镜像与环境绑定变化后，旧 PASS 不能证明当前结果。
9. 达到无进展/同根因上限就停止 Patch 并写 Replan；达到总预算则阻塞。换会话或 Replan 不重置预算。
10. 只有受保护 CI 可晋升 Baseline；STATE 的 DONE 不是完成证据。
11. Critical Invariant 违规立即阻塞。恢复前检查迁移和外部副作用，不能把 Git 回退当完整系统回退。
12. 完成规则以 Contract 的 `completion_policy` 为唯一来源（本工程为 `independent_auto`）；
    无法自动验证的部分如实报告为限制，不夸大交付范围。

## 本工程特有的操作约定

- 启动：`TODO_API_TOKENS='owner:token' npm start`（或 `node src/cli.mjs serve`）。
  没有 `TODO_API_TOKENS` 时 `serve` 拒绝启动，绝不降级为匿名服务。
- 优雅退出：关闭 stdin（或 SIGTERM/SIGINT）——父进程据此管理生命周期。
- 迁移：`npm run migrate`；迁移在监听端口之前完成，失败即非零退出。
- 受保护路径（会话不可写）：`.agent/CONTRACT.yaml`、`.agent/slices/**`、
  `tests/acceptance/spec/**`、`ci/verifier.yaml`、`ci/evidence/**`。
  修改既有 spec 会退出自动路径，需要 Owner 对具体差异的确认。

## 每次结束留下的最小摘要

- 当前候选和最后一次 CI 引用：本文件顶部 + `delivery_iteration action=status`（ITERATIONS.jsonl）
- 未完成义务/阻塞/剩余预算：`delivery_resume` 的输出
- 本轮被证伪的假设：见 `.agent/ITERATIONS.jsonl` 的 note / blocked 行
- 下一次具体动作及验证：同上
- 注意：`.agent/**` 是受保护路径，本会话不能写 `.agent/STATE.yaml`；摘要落在迭代日志与 AGENTS.md 中。
