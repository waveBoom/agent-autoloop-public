# 飞书周报与业务摘要

以本人权限读汇报、对照项目表，整理进展与待协调事项。默认周日北京时间 18 点读取过去七天的指定汇报和指定表格当前状态；完整读取后才调用 Agent，完整稿保存在本机，飞书给本人不含敏感明细的简短摘要。

## 怎么启用

1. 把本目录复制到 `~/.agent-autoloop/work/feishu-brief/`，目录权限设为 `0700`，不要放进 Git 仓库。两条规则使用同一台电脑、同一 `cwd` 和同一 `group`，读取和整理串行执行。
2. 把 `SKILL.md` 放到 `~/.codex/skills/feishu-brief/`；Claude Code 放到 `~/.claude/skills/feishu-brief/`。
3. 安装已登录本人身份的 `lark-cli`，先看 `lark-cli api --help` 和 `lark-cli base +record-list --help`，确认支持模板中的命令。只沿用已有授权，不在脚本里保存或导出 access token。
4. 修改 `sources.json`：`reportRule` 是已有汇报规则的准确名称，`reportUsers` 是需要汇总且本人有权查看的人员 open_id；`tables` 填自己的多维表格 token、table ID、原链接和必要字段名。不需要表格就填空数组。占位标识不能直接用，模板不会创建表格或扩大权限。
5. 合并规则的 `sources`、`agents`、`channels`、`rules`，替换接单电脑和路径；时区用 `Asia/Shanghai`。权限：`edit`，摘要 Agent 仅需读资料、写本地稿；联网读取由固定脚本完成，它只执行读取命令。
6. 运行 `agent-autoloop check`。在专用测试中台用假 CLI 验证采集、摘要派发、登录失效后的提问与续办，再启用自己的定时规则。

## 读取与保存范围

汇报接口为 `POST /open-apis/report/v1/tasks/query`，这是查询操作，所需权限为 `report:task:readonly`。所有读取均使用 `--as user`，只拿本人发起和收到的汇报，再按人员、规则、时间过滤；不会切到机器人身份获取更多数据。接口规范见[飞书查询汇报任务](https://open.feishu.cn/document/server-docs/report-v1/task/query.md)。没有看到某人的汇报，不等于他没提交。附件图片不会下载。

表格用 `base +record-list`，只读取指定字段，以 NDJSON 文件与 manifest 检查分页。直到 `has_more=false` 才算完整；跨页版本变化会报错，不能把部分数据说成完整汇总。不写回表格、OKR 或汇报。表格记录是当前快照，不能直接当作本周增量。

临时表格导出在读取结束后清理。完整本期资料保存在 `weekly-input.json`（权限 `0600`），摘要是 `briefs/<资料编号>.md`；它们属于本人的业务资料，不提交、不公开，也不在飞书卡片里附原文。新资料覆盖输入文件后，旧的排队事件不会错误使用新资料；完整历史摘要由本人按自己的保留期限管理。

本人登录或授权失效时只发一张问题卡片，没有 `brief.ready` 事件，不拿上次的文件冒充本周结果。本人恢复后点继续，重新完整读取；选“本期先跳过”结束本轮，下次计划时间再读；临时接口错误则如实失败，由中台现有机制处理。

## 飞书通知

规则默认登记 `feishu` 通道。把 `ou_REPLACE_ME` 换成本人的 open_id；在已有 `config.json` 的 `channels.feishu` 配上这个人的 `user` 和已有通道密钥。复用已运行的飞书通道，不另开监听。尚未接入时按[通道配置](../../../skills/agent-autoloop/SKILL.md#接一个通道)完成；配置涉及新密钥或权限时先取得本人授权。

读取业务资料使用本人身份，通知使用机器人身份。默认只发给本人；一个中台会把卡片交给它配置的所有通道，没有按规则单独选择收件人的功能。含私人资料的任务应使用只连本人私聊的中台，不要混入共享群通道。不要把密钥、实际 open_id、表格 token 或业务数据提交到仓库。
