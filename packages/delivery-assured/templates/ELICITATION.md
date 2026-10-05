# 义务发现与决定

- Intent：<精确引用；unknown>
- 项目类型/清单版本：<web_saas / cli / api，可多选；unknown>
- 当前状态：draft
- 起草依据：v0.5 附录 B.2；未处理 unknown 阻塞规划，本模板不表示 Gate 已通过。

## Journey 步骤表（每个步骤填写）

| 字段 | 内容 |
|---|---|
| Journey / Step | <目标、步骤 ID、角色和入口；unknown> |
| 前置条件 | <身份、数据、权限、外部依赖；unknown> |
| 成功结果 | <可观察结果、状态与持久化变化；unknown> |
| 失败 / 非法输入 | <每类失败、提示、恢复方式；unknown> |
| 身份 / 权限 | <未登录、过期、错误身份、权限不足；unknown> |
| 并发 / 重试 | <重复提交、超时重试、同时操作；unknown> |
| 界面 / 输出状态 | <空、加载、提交中、错误、成功及下一步；unknown> |
| 配置 / 部署 / 定位 | <必要约束及失败诊断；unknown> |
| Unknown / 假设 | <未决问题及影响；unknown> |
| 来源 / 决定 | <Intent、追问、清单 ID、你的确认引用；unknown> |

## 清单处置与缺口表（所选清单的每个 ID 一行）

| 清单 ID / 候选义务 | 处置 | 原因/边界 | Contract 义务/结果 | Unknown/假设 ID | 确认记录 |
|---|---|---|---|---|---|
| <ID / 候选义务> | unknown | <待决定；unknown> | <ID 或明确不适用> | U-<ID> | <待你的确认；unknown> |

允许处置为 required、excluded、not_applicable、unknown、deferred_with_approval。遍历所选清单全部 ID，不只填已想到的条目；重复项可映射同一义务。

- required：记录 Contract 义务/结果 ID、可观察结果及来源。
- excluded / not_applicable：记录原因、适用范围及你的确认引用；Critical 候选还须说明不适用原因或替代控制。
- unknown：记录问题、影响、建议及涉及 Journey / Rule，未处理时阻塞规划。
- deferred_with_approval：记录有界假设、风险、复查时点及你的确认引用；当前 Slice 验收仍须明确，不延期阻塞性正确性问题。

## Unknowns 表（你的第一个常规触点）

| ID | 问题 | Journey/Rule | 不回答的影响 | 建议选项 | 你的决定 | 状态/边界/复查时点 |
|---|---|---|---|---|---|---|
| U-<ID> | <问题；unknown> | <ID> | <影响；unknown> | <建议；非批准> | <待回答/排除/批准假设；unknown> | unresolved / <边界> / <复查时点> |

## Gate 结论

- 未处理 unknown：unknown（待全量检查，不填 0 冒充通过）
- 排除及延期的确认引用：<待你的确认；unknown>
- 阻塞性产品问题：<逐项写明或经核实为无；unknown>
- 下一步：补问题；Unknowns Gate 通过后才起草 Contract 并进入规划。

每个 Journey 步骤的每个维度都须有结论，不适用须明确处置；身份判定、资源归属、数据破坏、目标部署和关键 Journey 结果先解决。有界假设须有适用范围、失败后果及复查时点，Agent 不自行批准。结构检查只揭示已声明缺口；测试通过非完成，独立验收摘要确认、真实 CI Evidence、Baseline 与最终 staging/Journey Review 均另需真实记录。
