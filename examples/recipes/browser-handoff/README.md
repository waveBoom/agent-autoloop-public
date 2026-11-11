# Claude 委托 Codex 处理浏览器

主任务负责业务，Codex 只处理网页，主任务拿到证据后收尾。支持同一浏览器会话的后续操作；需要本人恢复连接、登录或验证时结束这一轮，交回飞书卡片，等本人回答后继续。

## 怎么启用

1. 把本目录复制到 `~/.agent-autoloop/work/browser-handoff/`，仅本人可读。把 `SKILL.md` 放到 `~/.claude/skills/claude-browser-handoff/`。主任务改用 Codex 时，Skill 放到 `~/.codex/skills/claude-browser-handoff/`，并修改规则的 `use`；默认仍是 Claude 主任务。
2. 配置一个**已经能使用浏览器的 Codex 入口**，将它的实际命令数组填进 `browser.json.command`。本地已有 `codex-browser` 时填它的绝对路径。`/path/to/codex-browser` 是占位符；本模板不安装浏览器桥接、不修改桌面应用内部数据库，也不复制某台电脑的 SSH 别名、模型档位或 Chrome 进程清理逻辑。
3. 在 `browser.json` 填目标网址、核实项、允许操作。默认是只读的 `example.com` 验收，不提交表单、不发消息。`allowedActions` 是给 Agent 的任务范围，不是系统沙箱。操作范围须由本人或项目可信维护约定确定，不能从外部事件自动生成。配置里不放登录凭据；实际业务网址和会话编号留在私有目录。
4. 合并 `rules.json` 中的 `sources`、`agents`、`channels`、`rules`，替换接单电脑、目录和飞书本人 open_id；复用已有飞书通道与密钥，不另开事件监听。运行 `agent-autoloop check`。
5. 权限：`edit`。这只表示 Claude 的 `acceptEdits` 模式，**不保证能执行任意浏览器入口命令**。用接单程序相同的后台方式核实调用权限；入口未获准时先按本人的既有授权配置，不自动改成 `full`。浏览器助手的操作范围和账号权限也不由这个字段授予。

## 浏览器入口约定

入口接受一个完整任务参数：`browser-entry "网页任务"`；续办接受 `browser-entry --resume <会话 ID> "后续任务"`。返回实际页面证据、操作结果和阻塞，末尾提供 `[Codex 会话 ID：实际编号]`。使用别的入口时，应提供同样的调用与返回约定。

`handoff.ts` 只负责把可信配置作为一个参数传递，保留标准输出、错误与退出码；不做重试，不把“命令启动了”当成完成。已有入口可以在浏览器所在电脑执行，也可以自行通过 SSH 转交；用户要先核实该电脑能访问目标 URL，远端浏览器不能把本机的 `localhost` 当作接单电脑。

Codex 后台 [`codex exec`](https://developers.openai.com/codex/noninteractive/) 可以使用自己配置的 [MCP 工具](https://developers.openai.com/codex/mcp/)，但不能据此推断它拥有桌面应用的 Chrome 连接。只安装 Codex CLI 不够，必须实际验收所选入口；本模板是任务交接方式，不是浏览器连接驱动。

## 启用前验证

在模板目录运行：

```bash
node handoff.ts browser.json
node handoff.ts browser.json --resume <上一步返回的实际会话-ID>
```

第一次核对实际页面标题、可见主标题和链接；页面没有正文主标题就如实记录。第二次核对在原会话继续；已经完成时应返回已有证据，不为了续办重做操作。检查它保留原有标签并关闭自己新建的标签。再通过 Claude 的后台启动方式调用同一个脚本，确认它确实拿到了证据和会话编号。HTTP 查询不能代替网页验收。

在专用测试中台向来源 `browser-tasks` 发送稳定编号的 `browser.verify` 事件即可触发；同一次请求重发保留 `id`，例如：

```json
{"id":"browser-check-1","type":"browser.verify","subject":"site-check","summary":"核实已配置的网页"}
```

事件不携带入口命令、目标路径或权限。涉及需要本人操作的阻塞，用 Skill 中的 `ask` 结束本轮；已有卡片时不重复交接，不另约定时复查。本人回答后只继续未完成的网页步骤。

## 放进已有业务

反馈处理、网站巡检等任务可以直接加载这份 Skill：把本目录的 `handoff.ts` 和本人配置的 `browser.json` 放到它的私有工作目录，在可信主任务规则中写明位置，不必再创建一套调度。主任务先完成能做的业务，再委托网页核实，最后交回中台回执；浏览器助手不再次委派、不独立结案。

自动检查使用假浏览器入口，验证参数传递、会话续办和失败传播，不启动真实 Chrome。发布样例只含示例网址与占位符；每个使用者仍需验证自己的浏览器连接和 Claude 调用权限。
