# 产品意图

- 当前状态：frozen
- 起草依据：v0.5 附录 B.1；本节记录用户需求原文与由它导出的决定。
- 项目：todo-api
- 目标用户：在单机上运行该服务的开发者；通过 HTTP 调用该服务的脚本或自动化代理
- 要解决的问题：没有可用的待办事项 HTTP 服务，无法用一条命令启动、用 HTTP 完成增删改查，
  也无法在重启后保留数据；手工验证每次都不可重复、不可审计
- 成功结果：用户可以用一条命令启动服务，用 HTTP 完成待办项的新增、查询、修改与删除，
  停止并以同一数据库文件重启后数据仍在；验收由脚本自动执行，不需要人工点击
- MVP 发布目标：内部/CI 干净安装可用
- 目标环境与平台：在 CI runner 上打包、干净安装并实际启动的 Node 进程；本机开发环境同样适用
- 必须保留的限制：Node 标准库优先（零运行时依赖）、单进程单机、SQLite 文件即数据边界
- 明确不做：浏览器界面；组织/角色权限模型；外部通知投递（见 Contract 的 out_of_scope）

## 核心用户旅程

| ID | 谁 | 从哪里开始 | 关键动作 | 最终可观察结果 |
|---|---|---|---|---|
| J-CREATE | 已认证的 API 客户端 | 一条凭据 + 空数据库 | POST /api/v1/todos | 201 与 Location，随后 GET 该位置返回同一条待办项 |
| J-READ | 已认证的 API 客户端 | 集合中已有数据 | GET 列表 / GET 单个 | 200 与 items 数组或单条表示；未知 id 返回 404 |
| J-UPDATE | 已认证的 API 客户端 | 自己拥有的待办项 | PATCH / PUT | 200 且 version 自增，GET 反映新值 |
| J-DELETE | 已认证的 API 客户端 | 自己拥有的待办项 | DELETE | 204；重复 DELETE 返回 404；列表不再包含它 |
| J-RUN | 运维者 | 未启动的仓库 | 按 README 启动、观察探针、重启 | /healthz 与 /readyz 返回 200；重启后数据仍可读 |

## 正式澄清

| 日期/记录 ID | 原问题 | 你的决定 | 影响的旅程/范围 |
|---|---|---|---|
| IT-001 | 创建 Todo HTTP API，支持增删改查、数据持久化，并提供清晰的启动方式与自动化验收 | 需求原文即验收目标；完成规则采用独立自动验收，不需要人工签收 | 全部 Journey 与完成规则 |
| U-MVP-ENV | MVP_READY 以哪个环境判定 | production_like_ci（CI 干净安装并实际启动的探针） | deployment、C-DEPLOYMENT |
| U-ID-SHAPE | id 如何生成，PUT 是否允许客户端指定 | POST 生成 UUIDv4；PUT 接受客户端 id 并做 create-or-replace | J-CREATE、J-UPDATE、C-IDEMPOTENCY |
| U-STORAGE | 持久化用什么存储 | Node 内置 node:sqlite，零 npm 运行时依赖 | C-PERSISTENCE、C-DEPENDENCY |
