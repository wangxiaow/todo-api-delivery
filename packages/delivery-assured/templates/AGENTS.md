# 项目工作规则

## Global Kernel（随当前 Slice 刷新）

- 产品目标与 Contract 摘要：<值；权威来源>
- MVP 范围与明确排除：<值>
- Critical Rules：<ID、主体/资源/操作、关键拒绝条件>
- 当前 Baseline：<受保护 ref、精确 revision、验证范围>
- 当前 Slice：<ID、目标、义务/结果、未完成项>
- 当前代码约定及来源 revision：
  - 数据访问与事务：<值>
  - 身份与授权：<值>
  - 错误处理与日志：<值>
  - 目录与模块：<值>
  - 命名与状态：<值>
  - 共享抽象：<值>

## 执行规则

1. 开始或恢复工作先运行 resume，读取当前受保护 Contract、Acceptance、Baseline 和 CI 失败记录。
2. 只推进当前 Slice；产品语义未知时记录 unknown，不能猜测后当作既定事实。
3. 遵循代码约定，优先复用已有授权、数据访问与错误处理入口；HOW 决策在 STATE 记一行。
4. 变更先回答三问：是否改变 Journey 结果、Critical Rule 主体/资源/操作、in/out-of-scope；任一为是就提交 Change Proposal，暂停受影响实现等待已有或新的明确授权。
5. 不删除 Required 义务，不降低断言，不 skip/only 必需 case，不自行缩小验收执行范围。
6. spec 只依赖语义 driver 接口；实现时可修改 driver，但不能加入 expect/assert、伪造结果或把异常转成成功。
7. 本地 PASS 用于诊断；每个 Candidate 由外部 CI 验证当前 Slice、全量 Spine、适用 Critical Rules 和必要环境。
8. Candidate 的代码、标准、验证配置、依赖、迁移、镜像与环境绑定变化后，旧 PASS 不能证明当前结果。
9. 达到无进展/同根因上限就停止 Patch 并写 Replan；达到总预算则阻塞。换会话或 Replan 不重置预算。
10. 只有受保护 CI 可晋升 Baseline；STATE 的 DONE 不是完成证据。新增既定语义下的测试经标准更新流程自动纳入，删除或降标需要明确确认。
11. Critical Invariant 违规立即阻塞。恢复前检查迁移和外部副作用，不能把 Git 回退当完整系统回退。
12. 完成规则以 Contract 的 `completion_policy` 为唯一来源：默认 `independent_auto`（全部 Required 与 Spine 在冻结候选上实际执行、发布前提被平台观测）；未声明按 `human_review` 处理；人工 Review 是用户主动选择的模式。无法自动验证的部分如实报告为限制，不夸大交付范围。

## 每次结束留下的最小摘要

- 当前候选和最后一次 CI 引用：<值>
- 未完成义务/阻塞/剩余预算：<值>
- 本轮被证伪的假设：<值或无>
- 下一次具体动作及验证：<值>
