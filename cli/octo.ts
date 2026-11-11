import { existsSync, readFileSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { parseArgs } from "node:util";
import { HOME } from "../host/home.ts";
import { readConfig } from "../host/config.ts";
import { cardReplyCommand, replyToCard } from "../plugins/octo/card-reply.ts";
import { issueActionCommand, octoIssueAction } from "./octo-issue-actions.ts";
import { handleGatewayIntake } from "../plugins/octo/intake-gateway.ts";
import { DraftRequired, type ChatTurn, type Draft } from "../plugins/octo/intake.ts";
import { collectOctoCommand } from "./collect-octo.ts";

export async function octoCommand(args: string[]) {
  const [action, ...rest] = args;
  if (action === "notify" || action === "complete") {
    const scoped = rest[0] === "--rule";
    if (scoped && !rest[1]?.trim()) throw new Error("请指定规则名称");
    console.log(
      await octoIssueAction(action, scoped ? rest.slice(2) : rest, undefined, undefined, scoped ? rest[1] : undefined),
    );
    return;
  }
  if (action === "deliver") return (await import("./deliver-octo-branch.ts")).deliverOctoBranch(rest);
  if (action === "collect") {
    const hasConfig = rest.some((part) => part === "--config" || part.startsWith("--config="));
    const config = process.env.AGENT_AUTOLOOP_OCTO_COLLECTOR_CONFIG ?? join(HOME, "octo-collector.json");
    const env = config.replace(/\.json$/, ".env");
    const hasEnv = rest.some((part) => part === "--env-file" || part.startsWith("--env-file="));
    return collectOctoCommand(
      hasConfig
        ? rest
        : ["--config", config, ...(!hasEnv && env !== config && existsSync(env) ? ["--env-file", env] : []), ...rest],
    );
  }
  if (action !== "request") throw new Error("用法：agent-autoloop octo collect [--config 文件] [--issue 编号]");
  const { values } = parseArgs({ args: rest, options: { "bot-dir": { type: "string" } } });
  const dir = values["bot-dir"];
  if (!dir || !isAbsolute(dir)) throw new Error("缺少机器人目录");
  const local = JSON.parse(readFileSync(join(dir, "intake.json"), "utf8"));
  const { apiUrl, botToken } = JSON.parse(readFileSync(join(dir, "config.json"), "utf8"));
  const input = readFileSync(0, "utf8");
  if (input.length > 50_000) throw new Error("机器人命令过长");
  const { turn, draft } = JSON.parse(input) as { turn: ChatTurn; draft?: Draft };
  if (
    ![turn?.channel, turn?.sender, turn?.message, turn?.text].every(
      (value) => typeof value === "string" && value.trim(),
    ) ||
    ![1, 2, 5].includes(turn.channelType ?? 0)
  )
    throw new Error("机器人命令缺少会话或发送者");
  try {
    const issueAction = issueActionCommand.exec(turn.text.trim());
    if (issueAction) {
      if (new URL(apiUrl).origin !== local.apiOrigin) throw new Error("Octo 网关与配置不符");
      let reply: string;
      try {
        reply = await octoIssueAction(
          issueAction[1] === "通知" ? "notify" : "complete",
          turn.text.trim().split(/\s+/).slice(1),
          { dir, turn },
        );
      } catch (error) {
        reply = error instanceof Error && !("code" in error) ? error.message : "操作未确认，请在 Hub 查看状态。";
      }
      console.log(JSON.stringify({ reply }));
      return;
    }
    if (cardReplyCommand.test(turn.text.trim())) {
      if (new URL(apiUrl).origin !== local.apiOrigin) throw new Error("Octo 网关与配置不符");
      console.log(JSON.stringify({ reply: await replyToCard(turn, dir, local.hubDb, HOME, readConfig()) }));
      return;
    }
    const reply = await handleGatewayIntake(
      { botId: local.botId, apiUrl, botToken, dataDir: join(dir, "data") },
      turn,
      async () => {
        if (draft === undefined) throw new DraftRequired();
        if (
          !draft ||
          typeof draft.title !== "string" ||
          typeof draft.description !== "string" ||
          !Array.isArray(draft.questions) ||
          draft.questions.length > 5 ||
          !draft.questions.every(
            (question) => typeof question === "string" && question.trim() && question.length <= 200,
          )
        ) {
          throw new Error("暂时无法生成需求草稿");
        }
        return draft;
      },
    );
    console.log(JSON.stringify({ reply }));
  } catch (error) {
    if (!(error instanceof DraftRequired)) throw error;
    console.log(JSON.stringify({ needsDraft: true }));
  }
}
