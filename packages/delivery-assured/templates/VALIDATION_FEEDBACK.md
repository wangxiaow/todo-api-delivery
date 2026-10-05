# 跨项目验证反馈表

> 用途：把操作包用到**另一个真实项目**上之后，用这一页把"哪里还漏、哪里还卡、哪里跑偏"带回来。
> 回填后发给我，我据此决定下一轮优化；**每一项优化都必须能指到 v0.5 或 v0.3 的某一行**，指不到就不做。
> 这一页本身不是证据，也不是完成凭证；它是一张"这次还丢了什么"的表（v0.5 §19）。

## A. 元信息（一次性）

| 项 | 值 |
|---|---|
| 项目 / 目标环境 | |
| 仓库路径与候选 SHA | |
| DSH 版本 / profile | |
| 插件与操作包版本（`plugins/dsh-delivery-assured`、`packages/delivery-assured` 的 revision） | |
| Contract revision / 受保护验收 revision | |
| 本阶段 Slice | |
| 安装方式（`install.mjs` 一键 / 手工） | |

## B. 必跑命令与粘贴区

在业务仓库里逐条运行，**原样粘贴输出（含退出码）**，不要转述结论：

```powershell
node <pack>/scripts/check-gaps.mjs --project . --phase contract
node <pack>/scripts/check-gaps.mjs --project . --phase acceptance
node <pack>/scripts/check-gaps.mjs --project . --phase slice --slice S1
node <pack>/scripts/coverage.mjs   --project . --view slice --slice S1
node <pack>/scripts/coverage.mjs   --project . --view mvp
node <pack>/scripts/resume.mjs     --project . --offline
node <pack>/scripts/verify.mjs     --project . --local --slice S1
```

```text
（粘贴区）
```

## C. 记分卡

### C1. 这次还丢了什么（v0.5 §19，一行一条，至少 3 条）

| 项目/日期 | 这次还丢了什么 | 分类（Contract 遗漏 / 标准缺陷 / 执行遗漏 / 回归 / 环境） | 在哪一步发现 | 加到哪里以免重犯 |
|---|---|---|---|---|
| | | | | |
| | | | | |
| | | | | |

### C2. 五个计数

| 计数 | 值 | 说明 |
|---|---|---|
| 需求遗漏数（交付后才发现） | | |
| 无效完成尝试（声称完成但被门禁拒绝） | | |
| 人工救援次数（你不得不出手纠正方向/写代码） | | |
| 回归逃逸（旧能力被破坏且未被 Spine 拦住） | | |
| 是否达成 MVP 上线（是/否 + 卡在哪一条） | | |

### C3. 监督层记录

| 问题 | 记录 |
|---|---|
| 会话启动时是否带上了监督摘要（Global Kernel）？内容是否准确？ | |
| `guard` 是否拦下过对受保护路径/权威引用的写入？拦下了什么？ | |
| 有没有该拦而没拦、或误拦正常写入的情况？ | |
| Skill 是否被加载、是否真的按它工作？ | |
| Agent 有没有声称完成/要求跳过某道门？你怎么处理的？ | |

### C4. 阻塞与绕行

| 阻塞 | 当时怎么处理（等待 / 绕过 / 改标准） | 是否留下了记录 |
|---|---|---|
| | | |

## D. 回传给我时请一并说明

1. 上面哪一项是**文档要求的**、哪一项是**文档没写但你觉得必要**的（后者会被当成"跑偏候选"审查）。
2. 你为了跑通而临时放宽过什么（哪一道门、哪一条断言、哪个计数）——放宽本身要留痕，不能悄悄发生。
3. 哪个提示/措辞让你误判了状态（例如把本地诊断当成完成）。

> 收到后我会：先核对文档出处 → 只在有出处的范围内改 → 用本地回归 + v0.3 §4.3 探针复验 → 把改动同时写进 REPAIR_NOTES 与对应文档。
