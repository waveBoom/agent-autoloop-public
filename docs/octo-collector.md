# 独立 Octo Loop 采集器

采集器用已有 octo-cli profile 只读查询 Octo Loop，将 Issue 创建和新增评论送入本机 Hub 的 `POST /v1/events`。Hub 默认监听 `127.0.0.1:3350`。采集器是独立命令，Hub 或 Worker 不负责启动它。

从 [示例配置](../examples/octo-collector.json) 准备私有配置。填入 profile、工作区的确切名称、指派人的确切姓名、本机 Hub 地址、规则文件及独立状态文件的绝对路径。状态文件的父目录须已存在。采集器只在本机回环地址提交事件。

Hub 使用与采集器相同的规则文件。Octo Issue 共用来源 `octo-issue`，只需在 Hub 创建一把来源密钥，传给 `AUTOLOOP_OCTO_ISSUE_KEY`。配置只记变量名。Octo 凭据由 octo-cli profile 管理。保管好状态文件，同一个状态文件只运行一个采集实例。

每条项目规则使用自己的事件类型对，例如报表项目的 `task.reporting.created` 和 `task.reporting.comment`，同步项目的 `task.sync.created` 和 `task.sync.comment`。规则的 `resumeOn` 指向对应评论类型。采集器按所选规则的创建类型确定这对事件，提交前检查两类事件是否分别只命中该规则。

```bash
node cli/collect-octo.ts --config /absolute/path/to/octo-collector.json --dry-run
node cli/collect-octo.ts --config /absolute/path/to/octo-collector.json --baseline
node cli/collect-octo.ts --config /absolute/path/to/octo-collector.json
node cli/collect-octo.ts --config /absolute/path/to/octo-collector.json --watch
node cli/collect-octo.ts --config /absolute/path/to/octo-collector.json --trigger
```

`--dry-run` 只查询与预演。`--baseline` 只建立一次本机基线，有旧状态时拒绝覆盖，可以在 Hub 启动前执行。首次正式运行若还没有基线，也只建立基线。基线快照中的 Issue，以及创建时间不晚于基线的 Issue，都视为历史任务。之后只接收基线后新建的合格 Issue 和这些 Issue 的新评论。已有状态时，预演返回本轮新增计数和需要选择归属的 Issue ID。正常单次执行只跑一轮，`--watch` 按配置间隔轮询。

自动采集默认每轮结束后等 600 秒。运行 `--watch` 时，另一个终端可以用 `--trigger` 提交一次立即采集请求。等待中的采集器每秒检查一次本机信号，正在查询的采集器在该轮结束后补采一轮。触发命令只写本机信号，不启动第二个采集器。未运行 `--watch` 时，可直接执行不带选项的单次采集。

手动指定 Issue 可运行 `node cli/collect-octo.ts --config <配置文件> --trigger --issue DEMO-253`。也支持 UUID 或路径末尾、查询参数含唯一编号的 HTTP(S) 链接。指定后立即单次提交创建事件，跳过历史基线，保留工作区、指派人、状态及规则校验。用 `--rule <规则名或别名>` 可指定规则，已采集的 Issue 可以补派到新规则，原规则的任务及事件编号保留。手动采集只提交创建事件，之后的普通采集继续跟进基线后的评论。加 `--dry-run` 只预演。请用独立状态文件做联调，避免与使用同一状态文件的 `--watch` 同时运行。

查询服务端按工作区、Octo UID 和状态允许列表过滤，并按返回的分页信息读取。只接收 `backlog`、`todo`、`in_progress`、`in_review`。每轮重新检查当前符合条件的任务，离开范围的任务暂停采集。已有归属且仍符合条件的任务读取评论分页。当前未以父 Issue 的更新时间作为评论采集信号。

首次匹配优先使用采集配置中的显式归属，其次读取正文的项目声明，最后按标题和正文关键词匹配。新 Issue 命中多条规则时，每条规则各提交一个创建事件，共用原 Issue 的 subject，事件编号按规则区分。首次发送前保存归属，各项目单独记录回执和评论去重状态。后续评论发给已保存的各条执行线。没有匹配、缺来源密钥，或单条事件无法唯一命中目标规则时，采集结果会列为待核对。

正常运行需先初始化并启动 Hub。本命令不创建 Octo 任务、发表评论或改变任务状态。任务描述和评论以标准事件资料传入 Hub，并受现有字段长度限制。采集器日志只输出计数、待处理任务 ID 与原因。

采集器保留 Octo 返回的 `url` 或 `web_url` 作为事件的 `link`。如果接口未提供网页地址，可在本机配置填写经过核实的 `taskUrlTemplate`，支持 `{taskId}`、`{identifier}`、`{workspaceId}` 和 `{workspaceSlug}`。模板必须含 `{taskId}` 或 `{identifier}`。缺少原链接或必要字段时，事件仍可采集，客户端可显示来源名。

网页地址模板示例为 `https://octo.example.invalid/fleet/{workspaceSlug}/issues/{identifier}`。例如演示工作区的 slug 为 `demo-workspace`，编号 `DEMO-246` 打开 [DEMO-246 原单](https://octo.example.invalid/fleet/demo-workspace/issues/DEMO-246)。slug 和短编号取自 Octo 的工作区及 Issue 数据，不从工作区名称或 UUID 猜测。

统一 CLI 可用 `agent-autoloop octo collect --issue DEMO-246`，也支持 `--watch`、`--trigger`、`--dry-run` 和 `--config`。默认读取 Hub 目录的 `octo-collector.json` 和可选的 `octo-collector.env`，可通过 `AGENT_AUTOLOOP_OCTO_COLLECTOR_CONFIG` 或参数指定隔离配置。Bot 的业务命令由 Gateway 转给同一 CLI 的内部入口 `octo request`，身份来自 Gateway 收到的消息。

无法确定任何项目时，该 Issue 本轮不入 Hub，也不会启动 Agent。采集器优先以建单记录识别需求方，否则使用 Octo 返回的创建人身份，并在发送前核对工作区和通知群成员。补资料卡说明请在原 Issue 正文填写「项目：规则别名」、目标或现象、范围和期望结果。下一轮采集重新判断。每个 Issue 的补资料提醒只发一次。无法核实接收人时，采集结果留下失败编号供负责人核对。

## 从聊天提交 Issue

配置 Octo Gateway 后，指定子区的机器人可以提供 `/提需求` 和 `/确认提需求`。把选定消息的文字粘贴到 `@issue-dispatcher /提需求` 后。机器人整理草稿，原提交人在同一子区执行草稿中的确认命令才创建 Issue。第一版记录提交命令的 Octo 消息编号作为出处。接口给出网页链接时返回链接，否则返回 Issue 编号。

对外机器人只处理 `/流程帮助` 列出的固定命令。草稿从用户粘贴的文字生成，普通消息和附件不会进入 Codex 会话。查询和流程操作通过各命令的权限校验执行。

第一行发送 `@issue-dispatcher /提需求 指派给 姓名或UID`，第二行起填写需求正文，可单列「项目：规则别名」，多个项目用顿号分隔。CLI 先校验项目归属，并按工作区成员名单核对指派人。重名时请提供 UID。草稿整理发现资料不足时只返回具体问题，不生成确认码。原提交人在同一子区确认后，使用草稿里保存的指派人建单。草稿、需求方、指派人和 Issue 关联保存在本机 `intake.sqlite`。建单超时或回执不明时保留待核对状态，可用 Issue 描述中的提交编号人工核对。

按所用 Gateway 的扩展方式接入机器人命令，升级后复核接线。首次上线要为该机器人的独立 Codex 目录登录，并验证一次从草稿到 Issue 再到 Hub 的真实链路。

交付卡经负责人处理后，`agent-autoloop octo deliver <交付卡号>` 推送短分支、核验远程提交，并在同一次 Hub 更新中关闭交付卡和标记「分支已交付 · 待人工测试」。重复采集同一评论不会改变状态。

获批的编码轮次结束后，Worker 核验远端配置的测试分支是否包含任务提交。核验通过后，Hub 将业务阶段记为「测试分支已推送: 分支名」。需要通知需求方时，可在看板填写 HTTPS 测试环境地址并发送。

- `agent-autoloop octo notify DEMO-256 test` 发送提测通知，`agent-autoloop octo notify DEMO-256 release` 发送需求上线通知。通知发往已配置的需求沟通子区并提醒原需求方。提测通知可附项目测试配置里的地址。通知按最新已采集评论划分轮次去重。
- `agent-autoloop octo complete DEMO-256 [结案原因]` 使用与看板「手动结案」相同的接口。结案后停止派发后续评论，若还有未结束的轮次则拒绝结案。
- 在审批子区原生 @ 机器人后，负责人可用 `/通知 DEMO-256 提测`、`/通知 DEMO-256 需求上线` 或 `/完成 DEMO-256 [结案原因]`。上线通知和手动结案分别执行。

在 Octo 群或子区，只要能原生 @ 到机器人，就可以发送 `/查进度 Issue编号` 查询本工作区已采集的 Issue，支持 UUID 和短编号。私聊仍核对工作区成员身份和原提交人。需求沟通群和指定子区也可以点入队卡的「查进度」。卡底附 `/help` 用法。按钮由同一机器人的 Autoloop 卡片事件监听处理，部署时需启用该机器人的原生审批监听。

`/我的需求` 显示自己最近提交的 10 条 Issue、提交时的指派人和 Hub 状态。采集器只跟踪当前指派给配置负责人的 Issue。「查进度」按钮和 `/查进度` 展示受理时间、当前阶段和可用的 Issue 链接。多项目 Issue 会逐项目显示当前状态和最新进展。`/查时间线` 保留排查用的采集、评论、回复和执行轮次记录。卡片均不展示内部日志、评论原文或审批备注。`/流程帮助` 或 `/help` 显示业务命令。群和子区的消息接收沿用 Octo 的 Bot 成员和 @ 机制。

采集配置可填写 `requesterBotDir`，指向 `issue-dispatcher` 的本机配置目录。该目录下的 `intake.json` 用 `requesterChannelId` 指定需求通知子区。Hub 确认各创建事件的规则归属后，采集器在该子区 @ 建单人，发出「已入队」通知，附 Issue 编号、可用链接和 `@issue-dispatcher /查进度 Issue编号` 的用法。时间线按实际领取记录显示「运行中」，并带可用的原单入口。结果通知单列下一步，说明是否需要操作。每个 Issue 通知一次，发送前核对建单记录、工作区和通知群成员身份。通知失败单独报告，评论仍可采集。查进度需要 Gateway 在线。

原生方案卡在采集事件有 Issue 链接时显示「查看 Issue」。确认或退回后，卡片仍保留该入口。

负责人可以在 Hub 所在机器触发通知。使用建单返回的 Issue UUID，选择 `materials`（补材料）、`review`（可验收）或 `delivered`（有交付结论）。默认预览，添加 `--send` 后投递到同一通知子区并 @ 建单人。发送前须已有面向需求方的 Issue 结论。一个 Issue 的同一节点最多投递一次，回执不明时先人工核对。

```bash
node cli/notify-octo-requester.ts --bot-dir /绝对路径/issue-dispatcher ISSUE-UUID review
```
