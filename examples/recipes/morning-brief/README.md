# 每日早报

## 解决什么
每天早上整理当前目录的笔记和提交，写到 `briefs/YYYY-MM-DD.md`，不用联网。

## 怎么启用
把本目录的 `SKILL.md` 复制到 `~/.codex/skills/morning-brief/`；Claude Code 用 `~/.claude/skills/morning-brief/`。
把 `rules.json` 的 `agents`、`rules` 并进 `~/.agent-autoloop/rules.json`，然后检查：
```bash
agent-autoloop check
```
规则几秒内生效；把 cron 临时设成 `* * * * *` 可在一分钟内试跑。

## 要改哪几处
- `worker` 换成 `agent-autoloop status` 显示的接单电脑；`use` 选 `codex` 或 `claude`。
- `cwd` 换成已有的笔记目录；`cron` 是当地时间，默认每天八点。
- 权限：`edit`。两种插件都能读本地资料、写早报；不需要联网或任意 shell 命令，见[权限说明](../../../docs/plugins.md#access-实际能做什么)。
