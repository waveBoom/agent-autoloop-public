# 跟进线上报错

## 解决什么
收到报错后对照本地代码查原因，需要重启就发卡片问你；示例重启脚本只打印文字。

## 怎么启用
把 `SKILL.md` 复制到 `~/.codex/skills/ops-alerts/`；Claude Code 用 `~/.claude/skills/ops-alerts/`，把 `restart.sh` 放到服务代码目录。
把 `rules.json` 并进 `~/.agent-autoloop/rules.json`，包括 `askFirst`；运行 `agent-autoloop check`，再用 `agent-autoloop key new source shop` 取得 `$SHOP_KEY`。
报错系统用自己的来源密钥发事件：
```bash
curl -fsS http://127.0.0.1:3350/v1/events -H "Authorization: Bearer $SHOP_KEY" -H 'Content-Type: application/json' -d '{"id":"checkout-20261104-0310","type":"alert.error","subject":"checkout","summary":"结账报错","detail":"TypeError: price is undefined at src/cart.ts:42"}'
```

## 要改哪几处
- 两处 `worker`、`cwd` 换成接单电脑和代码目录；`use` 选 `codex` 或 `claude`。
- 权限：`read`。只读代码和事件附带的调用栈，不需要联网；Claude 的 plan 是工具审批规则，不是系统沙箱，见[权限说明](../../../docs/plugins.md#access-实际能做什么)。
- `restart.sh` 换成固定的重启及健康检查命令；跨电脑发送前先按[配置手册](../../../skills/agent-autoloop/SKILL.md#放到服务器加电脑)设置地址。
- 不给 `shop-fix` 建外部来源密钥。重启脚本不受 `access` 限制，是否已获同意由 Skill 核对，不能当成强制审批。
