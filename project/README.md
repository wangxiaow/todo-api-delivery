# Todo HTTP API

一个零运行时依赖的 Todo HTTP API：Node 标准库 HTTP 服务 + 内置 `node:sqlite` 持久化。
支持新增、查询（列表与单个）、修改、删除，数据写在本地 SQLite 文件并在重启后保留。

## 启动方式

需要 Node.js **22.5 或更高版本**（`node:sqlite` 是内置模块，无需 `npm install`）。
本仓库没有任何运行时依赖，所以不需要安装步骤。

```bash
# 1) 配置凭据：<owner>:<token>，逗号分隔。没有凭据时服务拒绝启动（绝不降级为匿名）。
export TODO_API_TOKENS='alice:alice-secret,bob:bob-secret'     # Windows: $env:TODO_API_TOKENS='alice:alice-secret'

# 2) 启动（默认监听 127.0.0.1:8787，数据库 .agent/data/todos.db）
npm start
# 等价于：node src/cli.mjs serve
```

只准备数据库、不启动监听：

```bash
npm run migrate          # 等价于：node src/cli.mjs migrate
```

查看全部选项：

```bash
node src/cli.mjs --help
```

`serve` 会在监听端口之前完成数据库迁移：迁移失败时进程以非零退出码结束并在 stderr 说明
数据库路径，端口上不会有监听者。服务在 stdin 关闭时优雅退出（供父进程管理生命周期）。

### 全部环境变量

| 变量 | 默认值 | 含义 |
|---|---|---|
| `TODO_API_TOKENS` | 无（必填） | `owner:token` 列表，逗号分隔 |
| `TODO_HOST` | `127.0.0.1` | 监听地址 |
| `TODO_PORT` | `8787` | 监听端口，`0` 表示随机端口 |
| `TODO_DB_PATH` | `.agent/data/todos.db` | SQLite 文件路径 |
| `TODO_MAX_BODY_BYTES` | `65536` | 请求体上限，超出返回 413 |
| `TODO_MAX_TITLE_LENGTH` | `200` | 标题长度上限，超出返回 400 |
| `TODO_MAX_LIMIT` | `100` | 列表 `limit` 上限，超出返回 400 |
| `TODO_DEFAULT_LIMIT` | `20` | 列表默认页大小 |
| `TODO_MAX_TODOS_PER_OWNER` | `500` | 每位所有者的待办项上限，超出返回 429 |
| `TODO_REQUEST_TIMEOUT_MS` | `30000` | HTTP 请求超时 |
| `TODO_BUILD_REVISION` | 自动探测 | `/version` 报告的构建 revision |
| `TODO_ENVIRONMENT` | `production_like_ci` | `/version` 报告的环境名 |

## API

除 `/healthz`、`/readyz`、`/version` 外，所有请求都需要 `Authorization: Bearer <token>`。

| 方法 | 路径 | 说明 |
|---|---|---|
| `POST` | `/api/v1/todos` | 新增，返回 201 与 `Location`；支持 `Idempotency-Key` 去重 |
| `GET` | `/api/v1/todos` | 列表，支持 `limit`、`cursor`、`done`、`q` |
| `GET` | `/api/v1/todos/{id}` | 查询单个，未知 id 返回 404 |
| `PUT` | `/api/v1/todos/{id}` | create-or-replace（幂等），支持 `If-Match` |
| `PATCH` | `/api/v1/todos/{id}` | 局部修改，支持 `If-Match` |
| `DELETE` | `/api/v1/todos/{id}` | 删除，返回 204；重复删除返回 404 |
| `GET` | `/healthz` | 存活探针 |
| `GET` | `/readyz` | 就绪探针（数据库已打开并完成迁移） |
| `GET` | `/version` | 运行中进程的构建 revision、API 与 schema 版本、环境 |

示例：

```bash
curl -sS -X POST http://127.0.0.1:8787/api/v1/todos \
  -H 'Authorization: Bearer alice-secret' -H 'Content-Type: application/json' \
  -d '{"title":"buy milk","notes":"two litres"}'

curl -sS http://127.0.0.1:8787/api/v1/todos -H 'Authorization: Bearer alice-secret'
```

错误统一是 `{"error":{"code":...,"message":...,"request_id":...}}`；
错误响应不会包含凭据、SQL 文本或堆栈。

## 自动化验收

```bash
npm run acceptance          # 执行全部冻结验收 case（需要 Node >= 22.5）
npm run build               # 构建门：语法检查 + 冻结标准存在性 + 零依赖检查
npm run gate:clean-boot     # 干净启动门
npm run gate:persistence    # 持久化与迁移门
```

六道门（build / clean_boot / persistence_migration / slice_acceptance /
regression_spine / deployment）的定义与命令在 `ci/verifier.yaml`，由
`packages/delivery-assured/scripts/verify.mjs` 执行。本地的 PASS 只是诊断，
Evidence 由 CI 的受信任验证作业产生。

## 目录

| 路径 | 说明 |
|---|---|
| `src/` | 运行时实现：CLI、HTTP 表面、认证、领域逻辑、数据库与迁移 |
| `migrations/` | 顺序执行的 SQL 迁移 |
| `scripts/` | 构建与门禁命令 |
| `tests/acceptance/spec/` | 冻结验收标准（受保护，只读） |
| `tests/acceptance/driver/` | 语义驱动适配器：只观测、不判定 |
| `tests/harness/` | 执行冻结 case 并写出带 run token 的结果文件 |
| `.agent/` | Contract、Slice、项目元数据（受保护标准）与本地 Evidence 目录 |
| `ci/verifier.yaml` | 六道门的实际命令 |
