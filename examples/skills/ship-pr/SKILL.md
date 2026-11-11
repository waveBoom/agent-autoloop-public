---
name: ship-pr
description: 用 Agent 自动化中台的 delivery 插件交付合并请求，或处理审查回执中的问题。
---

# 把合并请求送上线

交付由 `plugins/delivery` 执行，配置见 [配置手册](../../../skills/agent-autoloop/SKILL.md#交付流水线)。不要在项目里再复制交付工具，也不要让普通 Agent 自行重做另一套合并流程。

- 项目 main 上的 `ops/delivery.json` 指定检查、发布、健康版本和审查命令；PR 自己改的设置本轮不使用。
- PR 打 `deliver` 后，插件审查只读文字快照，转 ready，等完整检查，核对提交和 main，写审查状态，合并并跟到 Ship 与健康版本一致。不启用自动合并。
- `deliver-review` 只审查；`deliver-attended` 表示有人盯着，问题留在回执，不另推通知。修复问题并推新提交后，来源再次投递，按新的提交重审。
- 合并后的发布失败要修复发布并重交原 PR；不能再次提交相同业务变化来假装完成。
- 普通 issue 的 `ask-owner` 变成问题卡片。回答后去掉标签，不向 GitHub 发评论。

处理审查问题的 Agent 可以在它自己的开发环境改代码。接单电脑的交付进程不检出、不执行 PR 的代码、测试、配置或 hooks。
