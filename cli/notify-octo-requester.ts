import { isAbsolute, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { parseArgs } from "node:util";
import { notification, stages } from "../plugins/octo/requester.ts";
import { readRequesterRoute, requesterDelivery } from "../plugins/octo/requester-delivery.ts";

async function main() {
  const { values, positionals } = parseArgs({
    options: { "bot-dir": { type: "string" }, send: { type: "boolean" } },
    allowPositionals: true,
  });
  const dir = values["bot-dir"];
  const [issue, stage] = positionals;
  if (!dir || !isAbsolute(dir) || positionals.length !== 2 || !Object.hasOwn(stages, stage)) {
    throw new Error(
      "用法：node cli/notify-octo-requester.ts --bot-dir /绝对路径 Issue-UUID materials|review|delivered [--send]",
    );
  }
  using db = new DatabaseSync(join(dir, "data", "intake.sqlite"), { readOnly: !values.send });
  db.exec("PRAGMA busy_timeout=3000");
  const route = readRequesterRoute(dir);
  const notice = notification(db, issue, stage as keyof typeof stages, route);
  if (!values.send) {
    console.log(notice.text);
    return;
  }
  const transport = requesterDelivery(dir, route);
  if (!(await transport.allowed(notice.sender))) throw new Error("需求方已不在目标工作区或通知群");
  const ref = await notice.send((channelId, content) => transport.send(channelId, content, notice.sender));
  console.log(`Octo 通知回执：${ref}`);
}

main().catch((error: unknown) => {
  console.error(error instanceof Error && !("code" in error) ? error.message : "无法读取通知配置或记录");
  process.exitCode = 1;
});
