# 义务发现与决定

- Intent：docs/INTENT.md（本文件是同一轮发现的结果，不是第二个需求来源）
- 项目类型/清单版本：api（checklists/api.yaml，revision 1，11 个条目）
- 当前状态：frozen
- 起草依据：v0.5 附录 B.2；未处理 unknown 阻塞规划，本文件不表示任何 Gate 已通过。

## Journey 步骤表

| 字段 | J-CREATE | J-READ | J-UPDATE | J-DELETE | J-RUN |
|---|---|---|---|---|---|
| 目标、步骤 ID、角色和入口 | J-CREATE；已认证客户端；POST /api/v1/todos | J-READ；已认证客户端；GET /api/v1/todos 与 /{id} | J-UPDATE；已认证客户端；PATCH / PUT /{id} | J-DELETE；已认证客户端；DELETE /{id} | J-RUN；运维者；node src/cli.mjs serve |
| 前置条件 | 有效 Bearer 凭据；数据库已迁移 | 同上；集合可为空 | 该待办项存在且属于本人 | 该待办项存在且属于本人 | Node >= 22.5；TODO_API_TOKENS 已配置 |
| 成功结果（可观察 + 持久化） | 201 + Location；GET 该位置返回同一条 | 200 + items/next_cursor 或单条表示 | 200 且 version 自增；GET 反映新值 | 204；随后 GET 404；列表不再包含 | /healthz 与 /readyz 200；/version 报告 revision 与 schema |
| 失败 / 非法输入 | 缺字段/未知字段/坏 JSON/超限 → 400/413，零持久化 | 未知 id → 404 not_found | 空 body → 400；陈旧 If-Match → 412 | 重复删除 → 404，不复活数据 | 数据库路径不可准备 → 非零退出并说明路径 |
| 身份 / 权限 | 缺失/空/错误凭据 → 401，绝不匿名 | 他人 id → 404，不泄漏存在性 | 他人 id → 404，零字段变化 | 他人 id → 404，零字段变化 | 探针不需要凭据；业务端点一律需要 |
| 并发 / 重试 | 同 Idempotency-Key 重复 → 同一个待办项；换 body → 409 | 分页游标可重复使用同一语义 | 并发同 If-Match → 一个 200 一个 412，无丢失更新 | 重复 DELETE 幂等 | 迁移可重复执行，第二次应用 0 个 |
| 界面 / 输出状态 | 201/200 + Location | 空集合 → 200 与空数组、null 游标 | 200 + 新 version | 204 无响应体 | 启动/关闭各打一行 JSON 日志；listening 含端口 |
| 配置 / 部署 / 定位 | 上限由环境变量声明（body/title/limit/quota） | limit 上限、非法游标有稳定错误码 | If-Match 语义在 README 与 /version 可查 | 删除后列表可遍历 | 六道门与启动命令都写在 README 与 ci/verifier.yaml |
| Unknown / 假设 | U-ID-SHAPE | —（列表边界已声明） | —（版本语义已声明） | — | U-MVP-ENV、U-STORAGE |
| 来源 / 决定 | 需求 IT-001；清单 API-VALIDATION/API-IDEMPOTENCY/API-RESOURCE | 需求 IT-001；清单 API-LIST | 需求 IT-001；清单 API-IDEMPOTENCY | 需求 IT-001；清单 API-IDEMPOTENCY | 需求 IT-001；清单 API-DEPLOYMENT/API-OBSERVABILITY |

## 清单处置与缺口表（api.yaml 全部 11 个条目）

| 清单 ID | 处置 | 原因/边界 | Contract 义务/结果 | 确认记录 |
|---|---|---|---|---|
| API-VALIDATION | required | 显式校验与一致状态码是数据完整性的前提 | C-VALIDATION, BR-VALIDATION | 需求 IT-001 |
| API-AUTHN | required | 服务以配置中的凭据集合为唯一边界，不降级为匿名 | C-AUTHN, BR-AUTHN | 需求 IT-001 |
| API-AUTHZ | required | 每个资源操作先校验 owner_id；跨所有者 404 且零变化 | C-AUTHZ, BR-AUTHZ | 需求 IT-001 |
| API-ERRORS | required | 错误信封固定，不含凭据/SQL/堆栈 | C-ERRORS, BR-SECRET | 需求 IT-001 |
| API-IDEMPOTENCY | required | Idempotency-Key、PUT create-or-replace、DELETE 可重复 | C-IDEMPOTENCY, BR-IDEMPOTENCY | 需求 IT-001 |
| API-PERSISTENCE | required | SQLite 文件 + 可重复迁移；重启后已提交写入仍可读 | C-PERSISTENCE, BR-DURABILITY | 需求 IT-001 |
| API-LIST | required | 空集合、limit/cursor 分页、done/q 过滤与边界错误 | C-LIST | 需求 IT-001 |
| API-DEPENDENCY | required | 无出站依赖；超大请求有界拒绝，失败后服务仍可用 | C-DEPENDENCY | 需求 IT-001 |
| API-OBSERVABILITY | required | request_id 回显/生成 + 一行结构化日志 + 两个探针 | C-OBSERVABILITY | 需求 IT-001 |
| API-DEPLOYMENT | required | /version 报告真实 revision 与 schema；迁移失败快速退出 | C-DEPLOYMENT | 需求 IT-001 |
| API-RESOURCE | required | body/title/limit/每位所有者数量上限均已声明并带错误码 | C-RESOURCE | 需求 IT-001 |

未使用 excluded / not_applicable / deferred_with_approval：本轮没有需要排除或延期的条目。

## Unknowns 表

| ID | 问题 | Journey/Rule | 不回答的影响 | 建议 | 决定 | 状态 |
|---|---|---|---|---|---|---|
| U-MVP-ENV | MVP_READY 以哪个环境判定 | deployment | 会断言一个无人观测的环境 | production_like_ci | production_like_ci（CI 干净安装并实际启动的探针） | resolved |
| U-ID-SHAPE | id 如何生成，PUT 是否允许客户端指定 | J-CREATE/J-UPDATE | create-or-replace 无法幂等 | POST 用 UUIDv4，PUT 接受客户端 id | 同上 | resolved |
| U-STORAGE | 持久化用什么存储 | C-PERSISTENCE | 原生扩展依赖会让干净安装脆弱 | 内置 node:sqlite | 内置 node:sqlite，零 npm 运行时依赖 | resolved |

## Gate 结论

- 未处理 unknown：0（三个 unknown 均以工程决定关闭，未改变任何可观察结果或范围）
- 排除及延期的确认引用：无
- 阻塞性产品问题：无。身份判定、资源归属、数据破坏与目标部署均已展开为 Critical 规则和负向 case
- 限制（如实声明，不等于通过）：并发只在单进程单机内被证明；内部 500 没有故障注入用例；
  交互式易用性无法自动判定
- 下一步：本地 PASS 只是诊断；Evidence 由受信任 CI 作业产生，Baseline 只由 Promotion 作业推进
