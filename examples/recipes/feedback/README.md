# 用户反馈处理

反馈触发维护，补充后接着处理，上线核实后回复。示例数据完全虚构；没有绑定某家反馈系统，也不自建工单库。

## 怎么启用

1. 把 `SKILL.md` 放到 `~/.codex/skills/handle-feedback/`；Claude Code 放到 `~/.claude/skills/handle-feedback/`。
2. 把 `rules.json` 的 `sources`、`agents`、`channels` 和 `rules` 合并进已有规则，保留现有条目；时区用 `Asia/Shanghai`。将 `worker` 改成接单电脑，`cwd` 改成自己的项目主目录。
3. 在项目 **main 上的维护手册** 写清真实的反馈读取、认领（如果原系统有）、版本核对、状态回写和回复入口，现有交付与线上验收步骤。工具使用已有 CLI 或 MCP，不把命令和仓库路径放进事件。模板不会猜你的接口。
4. 权限：`edit`。允许在获准目录内修复；Codex 的 shell 默认不能联网。反馈读取、PR 和交付需要实际可用的已配置工具；本地修改不等于发布。按[权限说明](../../../docs/plugins.md#access-实际能做什么)核实后台运行环境，不自动改成 `full`。
5. 运行 `agent-autoloop check`。用专用测试来源送入下面的虚构事件，先验证派活、提问和回答续办，再接真实反馈。

## 业务系统怎么送事件

使用已配置的来源密钥，来源必须叫 `feedback`。下面命令在本模板目录执行；`FEEDBACK_KEY` 从自己的凭据管理中读取，勿写进文件或 shell 历史。

```bash
curl --fail-with-body http://127.0.0.1:3350/v1/events \
  -H "Authorization: Bearer $FEEDBACK_KEY" \
  -H 'Content-Type: application/json' \
  --data-binary @event.json
```

新增用 `feedback.new`，补充用 `feedback.followup`。同条反馈始终用同一个 `subject`；每次真实变更用唯一、稳定的 `id`（例如反馈编号加版本），重发保留原编号。示例 `event.json` 不是可直接处理的真实工单，运行前必须配置读取入口；默认会请本人补齐入口。来源只送必要信息，不送联系方式、访问令牌、客户名单或日志全文。

来源事件不能代表本人批准：提问优先走中台 `ask`，回答会唤醒原事项。已有业务系统自己负责提问和回答的，沿用原系统经身份验证的决定，配置自己的续办事件；不要同时创建两张卡片。

默认每条反馈一个事项，最多并行 3 条；接单容量仍由原配置控制。外发回复先确认收件人和全文；已有明确授权可直接执行。回复失败只补回复，不重做已完成的发布。

## 飞书通知

规则默认登记 `feishu` 通道。把 `ou_REPLACE_ME` 换成本人的 open_id；在已有 `config.json` 的 `channels.feishu` 配上这个人的 `user` 和已有通道密钥。复用已运行的飞书通道，不另开监听。尚未接入时按[通道配置](../../../skills/agent-autoloop/SKILL.md#接一个通道)完成；配置涉及新密钥或权限时先取得本人授权。

读取业务资料使用本人身份，通知使用机器人身份。默认只发给本人；一个中台会把卡片交给它配置的所有通道，没有按规则单独选择收件人的功能。含私人资料的任务应使用只连本人私聊的中台，不要混入共享群通道。不要把密钥、实际 open_id、表格 token 或业务数据提交到仓库。
