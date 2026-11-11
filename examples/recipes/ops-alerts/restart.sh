#!/bin/sh
# The one thing here that touches production. It runs outside any sandbox, as you, whatever access the Agent has.
# It can run twice: a failure is tried again, and the hub only promises at least once.
set -e
echo "这是占位脚本，还没有真的重启。把这一行换成你的重启命令和健康检查，第一行输出会发给你。"
