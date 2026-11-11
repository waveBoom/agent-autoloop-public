import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { readConfig } from "../host/config.ts";
import { HOME, RULES_FILE } from "../host/home.ts";
import { hubClient } from "../protocol/client.ts";
import { parseRules } from "../protocol/rules.ts";
import { issueUrl, type ChatTurn } from "../plugins/octo/intake.ts";
import { milestoneNotification } from "../plugins/octo/requester.ts";
import { readRequesterRoute, requesterDelivery } from "../plugins/octo/requester-delivery.ts";
import { configuredTestAddress } from "../plugins/octo/test-delivery-profile.ts";

export const issueActionCommand = /^\/(通知|完成)(?:\s|$)/;

export async function octoIssueAction(
  action: "notify" | "complete",
  args: string[],
  gateway?: { dir: string; turn: ChatTurn },
  approvedStageAt?: string,
  requestedRule?: string,
) {
  const config = readConfig();
  const channel = config.channels?.octo;
  if (
    !config.hub ||
    !config.owner ||
    typeof channel?.botConfig !== "string" ||
    (gateway &&
      (channel.botConfig !== join(gateway.dir, "config.json") ||
        channel.approver !== gateway.turn.sender ||
        channel.channelId !== gateway.turn.channel ||
        channel.channelType !== gateway.turn.channelType ||
        ![2, 5].includes(gateway.turn.channelType ?? 0)))
  )
    throw new Error("仅限 Hub 本机负责人或指定审批子区的审批人操作。");
  const [raw, value, ...rest] = args;
  const label = raw?.toUpperCase();
  const stage =
    value === "test" || value === "提测" ? "test" : value === "release" || value === "需求上线" ? "release" : undefined;
  const manualTest = action === "notify" && stage === "test" && rest.length === 1;
  const suppliedAddress = manualTest ? rest[0] : "";
  const postRequest = suppliedAddress.startsWith("POST ");
  const manualUrl =
    suppliedAddress.length <= 500 ? issueUrl(postRequest ? suppliedAddress.slice(5) : suppliedAddress) : undefined;
  const manualAddress = manualUrl && (postRequest ? `POST ${manualUrl}` : manualUrl);
  if (manualTest && !manualAddress) throw new Error("请输入有效的 HTTPS 测试环境地址");
  if (
    !label ||
    !/^[A-Z][A-Z0-9_-]*-\d+$/.test(label) ||
    (action === "notify" && (!stage || (rest.length && !manualTest)))
  )
    throw new Error(
      action === "notify" ? "用法：octo notify Issue编号 test|release" : "用法：octo complete Issue编号 [结案原因]",
    );

  const dir = dirname(channel.botConfig);
  const route = readRequesterRoute(dir);
  using hub = new DatabaseSync(join(HOME, "hub.db"), { readOnly: true });
  const prefix = `loop:${route.local.workspaceId}:`;
  const rows = hub
    .prepare(
      `
    SELECT json_extract(r.data,'$.rule') AS rule, json_extract(r.data,'$.lane') AS subject,
      json_extract(e.data,'$.link') AS link, json_extract(e.data,'$.summary') AS summary,
      MIN(json_extract(e.data,'$.id')) AS first_event
    FROM projections e JOIN projections r ON r.collection='runs'
      AND json_extract(r.data,'$.lane')=json_extract(e.data,'$.subject')
    WHERE e.collection='events' AND json_extract(e.data,'$.source')='octo-issue'
      AND json_extract(e.data,'$.type') LIKE '%.created'
      AND substr(json_extract(e.data,'$.subject'),1,length(?))=?
      AND upper(substr(json_extract(e.data,'$.summary') || ' ',1,length(?) + 1))=?
    GROUP BY rule, subject
  `,
    )
    .all(prefix, prefix, label, label + " ");
  const matched = requestedRule === undefined ? rows : rows.filter((row) => row.rule === requestedRule);
  if (matched.length > 1) throw new Error("此 Issue 有多条执行线，请在看板打开对应项目再操作");
  const row = matched[0];
  if (!row || typeof row.rule !== "string" || typeof row.subject !== "string")
    throw new Error("Hub 中找不到唯一的 Issue 和规则归属。");
  const { rule, subject } = row;
  const owner = hubClient(config.url, config.owner);
  if (action === "complete") {
    const reason = args.slice(1).join(" ").trim() || "负责人手动结案";
    await owner.issueDisposition({ rule, subject, action: "close", reason });
    return `${label} 已结案。`;
  }
  const milestone = hub
    .prepare("SELECT data FROM projections WHERE collection='config' AND key=?")
    .get(`issue:${JSON.stringify([rule, subject])}`);
  const current = typeof milestone?.data === "string" ? JSON.parse(milestone.data) : {};
  if (approvedStageAt !== undefined && current.stageAt !== approvedStageAt) throw new Error("提测审批已过期");
  if (
    !manualTest &&
    (current.closed ||
      hub
        .prepare(
          `SELECT 1 FROM projections WHERE collection='runs' AND json_extract(data,'$.rule')=?
      AND json_extract(data,'$.lane')=? AND json_extract(data,'$.state') IN ('queued','claimed','unknown')`,
        )
        .get(rule, subject))
  )
    throw new Error("事项已结案或还有未结束的执行轮次");
  if (
    stage === "test" &&
    !manualTest &&
    !(current.stage === "test_approved" || (current.stage === "testing" && current.deployment))
  )
    throw new Error("请先记录测试环境部署成功，并确认提测卡");
  if (stage === "release" && current.stage === "deployed") throw new Error("请先处理当前提测确认卡");
  const cycle = Number(
    hub
      .prepare(
        `
    SELECT coalesce(max(json_extract(data,'$.id')),0) AS id FROM projections
    WHERE collection='events' AND json_extract(data,'$.source')='octo-issue'
    AND json_extract(data,'$.subject')=? AND json_extract(data,'$.type') LIKE '%.comment'
  `,
      )
      .get(subject)?.id,
  );
  let testAddress = manualAddress;
  if (stage === "test" && !manualTest) {
    const cwd = parseRules(readFileSync(RULES_FILE, "utf8"), Date.now(), "Asia/Shanghai").rules.find(
      (item) => item.name === rule,
    )?.cwd;
    testAddress = configuredTestAddress(cwd);
  }
  using db = new DatabaseSync(join(dir, "data", "intake.sqlite"));
  db.exec("PRAGMA busy_timeout=3000");
  const notice = milestoneNotification(
    db,
    {
      id: subject.slice(prefix.length),
      workspace: route.local.workspaceId,
      label,
      title: typeof row.summary === "string" ? row.summary.slice(label.length + 1) : undefined,
      url: issueUrl(row.link),
      cycle,
      ...(rows.length > 1 && { project: rule }),
      ...(stage === "test" && { version: current.deployment?.version }),
    },
    stage!,
    route,
    testAddress,
  );
  const transport = requesterDelivery(dir, route);
  if (!(await transport.allowed(notice.sender))) throw new Error("需求方已不在目标工作区或通知群");
  const ref = await notice.send(() => transport.send(route.requesterChannel, notice.text, notice.sender));
  await owner.issueDisposition({
    rule,
    subject,
    action: manualTest ? "manual-test-notified" : stage === "test" ? "test-notified" : "released",
    receipt: ref,
    expectedStageAt: current.stageAt,
  });
  return `${label} ${stage === "test" ? "提测" : "需求上线"}通知已发送，回执 ${ref}。`;
}
