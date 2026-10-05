# 交接说明（实现已完成；交付被受保护标准与平台前提阻塞）

本轮（IT-001）交付的产品实现、冻结标准与门禁命令都已推送到 `origin/main`。
下面写清已完成的部分、四个阻塞项、以及每一项的确切修法。**没有任何 Evidence，也没有任何
Baseline 被推进**：本地 PASS 只是诊断。

## 一、已完成并已推送

| 区域 | 内容 |
|---|---|
| `src/` | `cli.mjs`（serve/migrate/--help）、`config.mjs`（全部边界来自环境变量）、`logging.mjs`（单行 JSON）、`errors.mjs`（固定错误信封）、`auth.mjs`（常量时间比较）、`db.mjs`（`BEGIN IMMEDIATE` 事务）、`migrations.mjs`、`domain/todos.mjs`（归属/版本/幂等）、`http/{app,body,router}.mjs`、`server.mjs`、`version.mjs` |
| `migrations/001_init.sql` | `todos` + `idempotency_keys` + `schema_migrations` |
| `scripts/` | `build.mjs`、`gate-clean-boot.mjs`、`gate-persistence.mjs`、`gate-deployment.mjs`、`lib/runtime.mjs` |
| `tests/` | `acceptance/spec/`（manifest + 24 个冻结 case + 接口文档）、`acceptance/driver/index.mjs`（只观测不判定）、`harness/run-acceptance.mjs`（写出绑定 run token 的结果文件）、`spine/manifest.yaml` |
| `ci/verifier.yaml` | 六道门（deployment 声明 `local: skip`） |
| 文档 | `README.md`（启动方式、API 表、环境变量）、`docs/INTENT.md`、`docs/ELICITATION.md`、`AGENTS.md`、`package.json` |

启动方式（README 已文档化）：

```bash
export TODO_API_TOKENS='alice:alice-secret,bob:bob-secret'
npm start                 # = node src/cli.mjs serve
npm run migrate           # 只准备数据库
node src/cli.mjs --help
```

最近一次本地诊断（`delivery_verify_local`，未传 `--slice`）：

```
build                 passed
clean_boot            passed
persistence_migration passed
slice_acceptance      failed   -> 24 个冻结 Required case 中 23 个通过
regression_spine      passed
deployment            not_applicable  (ci/verifier.yaml 声明 local: skip)
blocking: GATE_FAILED slice_acceptance; CASE_NOT_PASSED A-AUTHZ-001
```

## 二、四个阻塞项与确切修法

### 1. `project/.agent/slices/S1.yaml` 缺失（会话不可写）

bootstrap 第 4 步把 `.agent/slices` 列为 Contract 的 companion，但写
`.agent/CONTRACT.yaml` 会立即关闭 bootstrap 窗口，之后再写 `.agent/slices/S1.yaml`
被 guard 以 “protected standard, not a Candidate artifact” 拒绝（之后对
`.agent/CONTRACT.yaml` 的 `edit` 同样被拒）。

后果：`resolveSlice(model,'S1')` 抛 `unknown or ambiguous Slice alias: S1`，因此
`verify.mjs --slice S1` 与 `ci-record --mode precheck` 在任何门之前就失败。

修法：由 Owner 落盘该文件，或重新打开 bootstrap 窗口。文件内容如下
（把它保存为 `project/.agent/slices/S1.yaml`）：

```yaml
id: S1
slice_key: S1
title: "Todo HTTP API 垂直切片：Bearer 边界内的增删改查 + SQLite 持久化 + 可观测启动"
status: READY
obligations:
  - J-CREATE
  - J-CREATE.CREATED
  - J-CREATE.REJECTED_INVALID
  - J-CREATE.REJECTED_UNAUTHENTICATED
  - J-READ
  - J-READ.LISTED
  - J-READ.FETCHED
  - J-READ.NOT_FOUND
  - J-UPDATE
  - J-UPDATE.UPDATED
  - J-UPDATE.PRECONDITION_FAILED
  - J-DELETE
  - J-DELETE.DELETED
  - J-DELETE.REPEAT_MISSING
  - J-RUN
  - J-RUN.STARTED
  - J-RUN.FAIL_FAST
  - J-RUN.PERSISTED_ACROSS_RESTART
  - C-HTTP-API
  - C-STARTUP
  - C-VALIDATION
  - C-AUTHN
  - C-AUTHZ
  - C-ERRORS
  - C-IDEMPOTENCY
  - C-PERSISTENCE
  - C-LIST
  - C-DEPENDENCY
  - C-OBSERVABILITY
  - C-DEPLOYMENT
  - C-RESOURCE
  - BR-AUTHN
  - BR-AUTHZ
  - BR-VALIDATION
  - BR-IDEMPOTENCY
  - BR-DURABILITY
  - BR-SECRET
outcomes:
  - J-CREATE.CREATED
  - J-READ.LISTED
  - J-UPDATE.UPDATED
  - J-DELETE.DELETED
  - J-RUN.STARTED
  - J-RUN.PERSISTED_ACROSS_RESTART
acceptance:
  - A-CREATE-001
  - A-VALIDATION-001
  - A-VALIDATION-BODY-001
  - A-AUTHN-001
  - A-AUTHZ-001
  - A-IDEMPOTENCY-POST-001
  - A-IDEMPOTENCY-PUT-001
  - A-IDEMPOTENCY-DELETE-001
  - A-READ-LIST-001
  - A-LIST-PAGINATION-001
  - A-UPDATE-PATCH-001
  - A-CONCURRENCY-PUT-001
  - A-READ-NOT-FOUND-001
  - A-PERSIST-RESTART-001
  - A-PERSIST-ATOMIC-001
  - A-MIGRATION-001
  - A-ERRORS-001
  - A-OBSERVABILITY-001
  - A-HEALTH-001
  - A-DEPLOY-VERSION-001
  - A-RESOURCE-QUOTA-001
  - A-DEPENDENCY-RECOVERY-001
  - A-STARTUP-FAILFAST-001
  - A-STARTUP-CLI-001
depends_on: []
baseline: "none — first Slice, parent Baseline #0"
preserve:
  - "本 Slice 的 24 个冻结 case 进入 Spine 后只增不减：后续候选必须在同一 case 集上重跑"
  - "错误信封形状 {error:{code,message,request_id}} 与状态码语义不得被后续修改破坏"
  - "已提交数据的重启可读性是既有能力，后续 Slice 不得以迁移或重构为名丢失"
code_conventions:
  - "数据访问与事务：所有写操作走 src/db.mjs 的 withTransaction，SQLite 使用 BEGIN IMMEDIATE；迁移只在 src/migrations.mjs 中按 migrations/*.sql 顺序执行"
  - "身份与授权：凭据到所有者的映射只在 src/auth.mjs 解析；每个资源操作在 src/domain/todos.mjs 中先校验 owner_id 再读写"
  - "错误处理与日志：错误一律经 src/errors.mjs 的 AppError 构造固定信封；日志只经 src/logging.mjs 输出单行 JSON"
  - "目录与模块：src/ 只放运行时代码，scripts/ 只放门禁与构建命令，tests/harness 负责执行与记录结果，tests/acceptance/driver 只做观测不做判定"
  - "命名与状态：HTTP 错误码使用 snake_case 常量；todo 的 version 从 1 开始且每次成功写入自增 1"
  - "共享抽象：HTTP 路由与请求体读取集中在 src/http/，领域层不直接接触 req/res；配置只在 src/config.mjs 读取环境变量"
attempt_budget:
  same_root_cause_limit: 3
  total_attempt_limit: 8
  no_progress_window: 3
  replan_limit: 2
migration_steps:
  - "001_init.sql 创建 todos 与 schema_migrations 表"
  - "启动时按文件名顺序应用未记录的迁移，成功后写入 schema_migrations"
  - "迁移在监听端口之前完成；失败时进程以非零退出码结束"
  - "回滚方式：迁移只做增量（IF NOT EXISTS），删除数据库文件即可回到空状态"
external_side_effects: []
```

### 2. `.agent/CONTRACT.yaml` 的 placeholder 误判（会话只读）

operation pack 的 `isPlaceholder` 是 `/\b(draft|unknown|TODO|TBD|FIXME)\b/i`，
大小写不敏感，因此领域词 **`todo` / `Todo`**（包括 `product.id: todo-api`）被当成模板文本。
`check-gaps` 因此在每个阶段都会报：

```
PLACEHOLDER_VALUE            (contract 阶段，扫全部字符串)
OUTCOME_NO_OBSERVABLE / CAPABILITY_NO_OBSERVABLE
RULE_NO_TEXT / RULE_NO_POSITIVE
CRITICAL_NO_NEGATIVE / CRITICAL_NO_FORBIDDEN_EFFECTS
```

修法（需要 Owner，因为该文件对会话只读）：把所有独立出现的 `todo`/`Todo` 换成不带该
词边界的写法，例如

- `product.id: todo-api` → `product.id: todolist-api`（`todolist` 中 `todo` 后无词边界）
- 正文里的 “Todo / todo” → “待办项 / 待办”
- `business_rules[].acceptance_requirements` 的字符串同时被 manifest 的
  `critical_scenarios` 逐字引用（`checkCriticalDerivation` 做精确匹配），所以两边必须
  同时改；改法建议把 “todo” 换成 “task”：
  - `"valid token can create and read todos"` → `"valid token can create and read tasks"`
  - `"the owner can read and change its own todo"` → `"the owner can read and change its own task"`
  - `"a repeated idempotency key returns the first todo instead of creating a second"` → `... the first task ...`
  - `"a committed todo is readable with the same id and title after a process restart"` → `... a committed task ...`
  - `"no todo is created and no todo is returned for an unauthenticated request"` → `"no task is created and no task is returned for an unauthenticated request"`
  - `"a rejected request persists no todo and changes no stored todo"` → `"a rejected request persists no task and changes no stored task"`
  - `"a repeated submission stores no second todo"` → `"a repeated submission stores no second task"`
  - `"a restart loses no committed todo and creates no duplicate"` → `"a restart loses no committed task and creates no duplicate"`
  - manifest 中对应 case 的 `assertions` / `critical_scenarios` 同步替换。

### 3. `tests/acceptance/spec/A-AUTHZ-001.mjs` 的断言读错了时刻（会话只读）

第 23 行读取 `aliceRead`，第 24 行才执行 `alicePatch`；而第 43 行的断言
`'only the owner's own PATCH advanced the version'` 用
`after = observed.aliceRead.body` 要求 `version === 2 && done === true`。
在任何诚实实现下（GET 不改数据、跨所有者一律 404 且零字段变化）此时只能是
`version === 1 && done === false`，所以该 case **不可能通过**。

修法是**加强**而不是削弱（新增一次观测、保留全部既有断言）：

```diff
     const aliceRead = await api.request(server, { method: 'GET', path, token: 'alice-secret' })
     const alicePatch = await api.request(server, { method: 'PATCH', path, token: 'alice-secret', body: { done: true } })
-    return { created, bobRead, bobPatch, bobPut, bobDelete, aliceRead, alicePatch }
+    const aliceAfterPatch = await api.request(server, { method: 'GET', path, token: 'alice-secret' })
+    return { created, bobRead, bobPatch, bobPut, bobDelete, aliceRead, alicePatch, aliceAfterPatch }
@@
-    ['only the owner\'s own PATCH advanced the version', Boolean(after) && after.version === 2 && after.done === true, `after=${JSON.stringify(after)}`],
+    ['only the owner\'s own PATCH advanced the version', Boolean(observed.aliceAfterPatch && observed.aliceAfterPatch.body) && observed.aliceAfterPatch.body.version === 2 && observed.aliceAfterPatch.body.done === true, `after=${JSON.stringify(observed.aliceAfterPatch && observed.aliceAfterPatch.body)}`],
```

按 v0.5 §5.4，修改既有 spec 会退出自动路径，需要对这一处具体差异的确认。

### 4. 平台前提未配置

verify run 37301617297（候选 `f5b6357`）两个 job 都在**第一步**失败，没有产出
evidence artifact：

```
structural checks / Freeze and compare both nonempty project acceptance trees
  git fetch --no-tags origin refs/heads/standards/acceptance
  fatal: could not read Username for 'https://github.com': No such device or address
verify candidate / Freeze candidate and protected standard   (同一步，同一原因)
```

- 仓库是 **private**，而 checkout 使用 `persist-credentials: false`，所以按 ref 抓取
  `standards/acceptance` 时无法认证（紧邻的按 SHA 抓取候选是成功的）。
- 需要的 ref 都还不存在：`refs/heads/standards/acceptance`（Owner 建立的第一个标准）与
  `refs/heads/delivery-state/main`（Owner 批准的初始 durable state）。
- Secrets 只有 `STATE_PUSH_TOKEN`；缺 `BASELINE_PUSH_TOKEN`、`STANDARDS_PUSH_TOKEN`。
- 变量 `VERIFY_MACHINE_ID` / `PROMOTION_MACHINE_ID` 未配置，而 promote 工作流要求它们存在且不同。

修法：Owner 建立这两个 ref（或用 `promote` 工作流的 `bootstrap-state`
模式以 `bootstrap_seed=owner-approved-empty` 初始化），补齐上述 token 与变量，
并让按 ref 抓取能认证（公开仓库，或在工作流里提供只读 token）。

## 三、下一步顺序

1. Owner 处理上面 1–3（或重新打开 bootstrap 窗口）；这三项都在受保护标准里。
2. Owner 处理第 4 项平台前提。
3. 然后 dispatch verify（本会话已用 `delivery_ci action=request workflow=verify` 成功发起过一次，
   见 run 37301617297），读那一次确切 run 的结果。
4. 只有在 verify 真实 PASS 之后，才由 Promotion 作业处理 Baseline #0；MVP_READY 还需要
   发布前提被平台观测到（本工程声明了 `required_check_runs_on_candidate` 与
   `verification_workflow_active`）。
