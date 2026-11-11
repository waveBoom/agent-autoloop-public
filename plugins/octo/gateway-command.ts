import { spawn } from "node:child_process";
import { dirname, join } from "node:path";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { sendPayload } from "./channel.ts";
import { draftFromSelection, type ChatTurn, type Draft } from "./intake.ts";
import type { Settings } from "./intake-gateway.ts";
import { requesterCard } from "./requester-delivery.ts";

export async function handleGatewayCommand(
  bot: Pick<Settings, "apiUrl" | "botToken" | "botId"> & { dataDir: string },
  turn: ChatTurn,
) {
  const command = turn.text.trim();
  const help = "我只处理 Issue 流程命令。发送 /流程帮助 查看可用操作。";
  if (!/^\/(?:提需求|确认提需求|查进度|进度|查时间线|我的需求|回复卡|通知|完成|流程帮助|help)(?:\s|$)/.test(command))
    return help;
  const dir = dirname(bot.dataDir);
  const local = JSON.parse(readFileSync(join(dir, "intake.json"), "utf8"));
  if (local.botId !== bot.botId || new URL(bot.apiUrl).origin !== local.apiOrigin) return;
  const entry = fileURLToPath(new URL("../../bin/agent-autoloop.ts", import.meta.url));
  function runCommand(draft?: Draft) {
    return new Promise<{ reply?: string; needsDraft?: true }>((resolve, reject) => {
      const child = spawn(
        process.execPath,
        ["--disable-warning=ExperimentalWarning", entry, "octo", "request", "--bot-dir", dir],
        {
          stdio: ["pipe", "pipe", "ignore"],
          timeout: 30_000,
        },
      );
      let output = "";
      child.stdout.setEncoding("utf8").on("data", (chunk: string) => {
        output += chunk;
        if (output.length > 50_000) child.kill();
      });
      child.stdin.on("error", () => {});
      child.on("error", reject);
      child.on("close", (code) => {
        try {
          const result = JSON.parse(output);
          if (code === 0 && (result.reply === undefined || typeof result.reply === "string")) return resolve(result);
        } catch {}
        reject(new Error("Octo 请求 CLI 未返回结果"));
      });
      child.stdin.end(JSON.stringify({ turn, draft }));
    });
  }
  let reply: string | undefined;
  try {
    let result = await runCommand();
    if (result.needsDraft) {
      const selection = /^\/提需求\s+指派给[^\r\n]*\r?\n([\s\S]{1,12000})$/.exec(turn.text.trim())?.[1];
      if (!selection) return "请在第二行起填写需求正文。";
      result = await runCommand(draftFromSelection(selection));
    }
    reply = result.reply;
  } catch {
    return "暂时无法读取工作流结果，请稍后再试。";
  }
  if (reply === undefined) return "当前会话无法使用该命令。请发送 /流程帮助 查看使用范围。";
  if (!reply) return "";
  if (/^\/(?:查进度|进度|查时间线|我的需求|提需求|确认提需求)(?:\s|$)/.test(turn.text.trim())) {
    const url = new URL(bot.apiUrl);
    if (
      url.protocol !== "https:" ||
      url.username ||
      url.password ||
      url.search ||
      url.hash ||
      ![1, 2, 5].includes(turn.channelType ?? 0)
    )
      return reply;
    try {
      await sendPayload(
        {
          endpoint: `${url.href.replace(/\/+$/, "")}/v1/bot/sendMessage`,
          token: bot.botToken,
          channelId: turn.channel,
          channelType: turn.channelType!,
        },
        requesterCard(reply),
        AbortSignal.timeout(10_000),
      );
      return ""; // The gateway handles the command but the card is already sent.
    } catch {
      // A lost receipt can mean Octo stored the card. Do not send a second response.
      return "";
    }
  }
  return reply;
}
