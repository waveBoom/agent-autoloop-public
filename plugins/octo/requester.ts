import type { DatabaseSync, SQLInputValue } from "node:sqlite";
import { issueProgress } from "../../kernel/issue-progress.ts";
import { issueTitleLine, issueUrl } from "./intake.ts";

export const stages = {
  materials: "需要补充材料",
  review: "可以开始验收",
  delivered: "已有交付结论",
};
type Stage = keyof typeof stages;
type Issue = { issue: string; url: string | null; sender: string; identifier?: string | null };
const shortId = /^[A-Za-z][A-Za-z0-9_-]*-\d+$/;

function intakeFields(db: DatabaseSync, fields: string[]) {
  const columns = new Set(
    db
      .prepare("PRAGMA table_info(octo_intake)")
      .all()
      .map((row) => row.name),
  );
  return fields.map((field) => (columns.has(field) ? field : `NULL AS ${field}`)).join(", ");
}

async function deliverOnce(db: DatabaseSync, id: string, stage: string, deliver: () => Promise<string>) {
  db.exec(`CREATE TABLE IF NOT EXISTS octo_requester_notice (
    issue TEXT NOT NULL, stage TEXT NOT NULL, ref TEXT, PRIMARY KEY (issue,stage)
  )`);
  const claim = db.prepare("INSERT OR IGNORE INTO octo_requester_notice (issue,stage) VALUES (?,?)").run(id, stage);
  if (!claim.changes) {
    const prior = db.prepare("SELECT ref FROM octo_requester_notice WHERE issue=? AND stage=?").get(id, stage);
    if (typeof prior?.ref === "string") return prior.ref;
    throw new Error("此前发送结果待人工核对");
  }
  try {
    const ref = await deliver();
    db.prepare("UPDATE octo_requester_notice SET ref=? WHERE issue=? AND stage=?").run(ref, id, stage);
    return ref;
  } catch {
    throw new Error("发送结果待人工核对");
  }
}

export function clarificationNotification(
  db: DatabaseSync,
  issue: string,
  label: string,
  sender: string,
  title?: string,
) {
  const text = [
    `Issue ${label} · 待补充资料`,
    ...issueTitleLine(title),
    "目前无法唯一确定项目和执行规则，暂未安排 Agent。",
    "请在原 Issue 正文加一行「项目：规则别名」，并补充目标或异常现象、影响范围和期望结果。",
    "补齐后，下一轮定时采集会重新核对。",
  ].join("\n");
  return { sender, text, send: (deliver: () => Promise<string>) => deliverOnce(db, issue, "clarification", deliver) };
}

type NoticeRoute = { intakeChannel: string; requesterChannel: string };
type ObservedRequester = { workspace: string; issue: string; sender: string; identifier?: string; url?: string };

export function rememberObservedRequester(db: DatabaseSync, entry: ObservedRequester) {
  db.exec(`CREATE TABLE IF NOT EXISTS octo_observed_requester (
    workspace TEXT NOT NULL, issue TEXT NOT NULL, sender TEXT NOT NULL, identifier TEXT, url TEXT,
    PRIMARY KEY (workspace,issue)
  )`);
  db.prepare("INSERT OR IGNORE INTO octo_observed_requester VALUES (?,?,?,?,?)").run(
    entry.workspace,
    entry.issue,
    entry.sender,
    entry.identifier ?? null,
    issueUrl(entry.url) ?? null,
  );
  const row = db
    .prepare("SELECT sender FROM octo_observed_requester WHERE workspace=? AND issue=?")
    .get(entry.workspace, entry.issue);
  if (row?.sender !== entry.sender) throw new Error("Issue 创建人与此前核对的记录不符");
}

function tableExists(db: DatabaseSync, table: string) {
  return Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(table));
}

export function confirmedRequester(db: DatabaseSync, id: string, intakeChannel: string) {
  if (!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='octo_intake'").get()) return;
  const matches = db
    .prepare(
      `SELECT sender, url, ${intakeFields(db, ["title"])} FROM octo_intake WHERE issue=? AND channel=? AND state='created'`,
    )
    .all(id, intakeChannel);
  const sender = matches[0]?.sender;
  if (matches.length !== 1 || typeof sender !== "string" || !sender) return;
  return { sender, url: issueUrl(matches[0].url), title: matches[0].title };
}

export function milestoneNotification(
  db: DatabaseSync,
  issue: {
    id: string;
    workspace: string;
    label: string;
    title?: string;
    url?: string;
    cycle: number;
    version?: string;
    project?: string;
  },
  stage: "test" | "release",
  route: NoticeRoute,
  testAddress?: string,
) {
  const observed = tableExists(db, "octo_observed_requester")
    ? db
        .prepare("SELECT sender FROM octo_observed_requester WHERE workspace=? AND issue=?")
        .get(issue.workspace, issue.id)
    : undefined;
  const requester = confirmedRequester(db, issue.id, route.intakeChannel);
  const sender = requester?.sender ?? observed?.sender;
  if (typeof sender !== "string" || !sender) throw new Error("找不到已核验的需求方");
  const text = [
    `Issue ${issue.label} · ${issue.project ? `${issue.project} · ` : ""}${stage === "test" ? "可以开始测试" : "需求已上线"}`,
    ...issueTitleLine(issue.title || requester?.title),
    stage === "test" ? "请验证需求。如有问题，请在原 Issue 评论反馈。" : "需求已上线，请查看原 Issue 了解交付内容。",
    ...(stage === "test" && testAddress ? [`测试地址：${testAddress}`] : []),
    ...(issue.url ? [issue.url] : []),
  ].join("\n");
  return {
    sender,
    text,
    send: (deliver: () => Promise<string>) =>
      deliverOnce(
        db,
        issue.id,
        issue.project
          ? JSON.stringify([stage, issue.cycle, issue.version, issue.project])
          : issue.version
            ? JSON.stringify([stage, issue.cycle, issue.version])
            : `${stage}:${issue.cycle}`,
        deliver,
      ),
  };
}

export function startNotification(
  db: DatabaseSync,
  id: string,
  route: NoticeRoute,
  identifier?: string,
  link?: string,
  verifiedCreator?: string,
  title?: string,
) {
  const requester =
    confirmedRequester(db, id, route.intakeChannel) ??
    (verifiedCreator ? { sender: verifiedCreator, url: undefined, title: undefined } : undefined);
  if (!requester) return;
  const { sender } = requester;
  const label = identifier && /^[A-Za-z0-9_-]{1,80}$/.test(identifier) ? identifier : id;
  const url = issueUrl(link) ?? requester.url;
  const text = [
    `Issue ${label} · 已入队`,
    ...issueTitleLine(title || requester.title),
    "Hub 已接收 Issue。当前状态请以查进度结果为准。",
    ...(url ? [url] : []),
    `查进度命令：/查进度 ${label}`,
  ].join("\n");
  return {
    sender,
    pending() {
      if (!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='octo_requester_notice'").get())
        return true;
      const row = db.prepare("SELECT ref FROM octo_requester_notice WHERE issue=? AND stage='started'").get(id);
      if (!row) return true;
      if (typeof row.ref === "string") return false;
      throw new Error("此前发送结果待人工核对");
    },
    send(deliver: (channel: string, text: string, uid: string) => Promise<string>) {
      return deliverOnce(db, id, "started", () => deliver(route.requesterChannel, text, sender));
    },
  };
}

function prepareReturnChannel(db: DatabaseSync) {
  db.exec("CREATE TABLE IF NOT EXISTS octo_requester_dm (sender TEXT PRIMARY KEY, channel TEXT NOT NULL)");
}

export function requesterProgress(
  db: DatabaseSync | undefined,
  hub: DatabaseSync,
  workspace: string,
  sender: string,
  label: string,
  dm?: string,
  includeTimeline = false,
  groupAccess = false,
):
  | {
      label: string;
      state: string;
      publicState: string;
      latestProgress?: string;
      projects?: { rule: string; state: string; latestProgress?: string }[];
      receivedAt?: string;
      url?: string;
      timeline?: { state: string; at: string | undefined }[];
    }
  | undefined {
  if (!sender) return;
  const prefix = `loop:${workspace}:`;
  const candidates = (
    groupAccess
      ? hub
          .prepare(
            `SELECT DISTINCT substr(subject, length(?) + 1) AS issue, NULL AS url
        FROM (SELECT json_extract(data,'$.subject') AS subject, json_extract(data,'$.summary') AS summary
          FROM projections
          WHERE collection='events' AND json_extract(data,'$.source')='octo-issue'
          AND json_extract(data,'$.type') LIKE '%.created')
        WHERE substr(subject, 1, length(?))=?
        AND (substr(subject, length(?) + 1)=? OR upper(substr(summary, 1, instr(summary || ' ', ' ') - 1))=?)`,
          )
          .all(prefix, prefix, prefix, prefix, label, label.toUpperCase())
      : db && tableExists(db, "octo_intake")
        ? db
            .prepare(
              `SELECT issue, url, ${intakeFields(db, ["identifier"])} FROM octo_intake WHERE state='created' AND sender=?`,
            )
            .all(sender)
        : []
  ) as Issue[];
  if (!groupAccess && db && tableExists(db, "octo_observed_requester")) {
    const extra = db
      .prepare("SELECT issue,url,identifier FROM octo_observed_requester WHERE workspace=? AND sender=?")
      .all(workspace, sender) as Issue[];
    const hasIntake = tableExists(db, "octo_intake");
    const botOwned = hasIntake ? db.prepare("SELECT 1 FROM octo_intake WHERE issue=? AND state='created'") : undefined;
    candidates.push(...extra.filter((entry) => !botOwned?.get(entry.issue)));
  }
  if (!candidates.length) return;
  const latestEvent =
    hub.prepare(`SELECT json_extract(data,'$.summary') AS summary, json_extract(data,'$.link') AS link,
    json_extract(data,'$.received_at') AS receivedAt, json_extract(data,'$.routed') AS routed
    FROM projections WHERE collection='events' AND json_extract(data,'$.source')='octo-issue'
    AND json_extract(data,'$.subject')=? AND json_extract(data,'$.type') LIKE '%.created'
    ORDER BY json_extract(data,'$.id')`);
  const match = candidates.flatMap((issue) => {
    const subject = prefix + issue.issue;
    const events = latestEvent.all(subject);
    const event = events.at(-1);
    const identifier = typeof event?.summary === "string" ? event.summary.split(" ", 1)[0] : "";
    return issue.issue === label ||
      [identifier, issue.identifier].some((value) => value?.toUpperCase() === label.toUpperCase())
      ? [{ issue, subject, event, events }]
      : [];
  });
  if (match.length !== 1) return;
  const [{ issue, subject, event, events }] = match;
  const routed = [
    ...new Set<string>(events.flatMap(({ routed }) => (typeof routed === "string" ? JSON.parse(routed) : []))),
  ];
  const read = <T>(sql: string, params: SQLInputValue[] = []) => hub.prepare(sql).all(...params) as T[];
  const projects =
    routed.length > 1
      ? routed.map((rule) => {
          const progress = issueProgress(read, subject, rule, true);
          return { rule, state: progress.displayLabel, latestProgress: progress.latestProgress };
        })
      : undefined;
  const {
    runs,
    active,
    waiting,
    displayLabel: publicState,
    latestProgress,
  } = issueProgress(read, subject, routed.length === 1 ? routed[0] : undefined, Boolean(event));
  const states: Record<string, string> = {
    queued: "排队中",
    claimed: "运行中",
    running: "运行中",
    done: "最近一轮已完成",
    failed: "最近一轮执行失败",
    cancelled: "最近一轮已取消",
    unknown: "执行状态待核对",
  };
  const state = active
    ? "运行中"
    : waiting
      ? "等待负责人确认"
      : (states[String(runs[0]?.state)] ?? (event ? "已采集，等待安排" : "尚未进入 Hub"));
  const timelineLabel = (text: string, rule?: string) => (projects && rule ? `${rule} · ${text}` : text);
  const timeline = includeTimeline
    ? [
        ...hub
          .prepare(
            `SELECT json_extract(data,'$.type') AS type, json_extract(data,'$.received_at') AS at,
              json_extract(data,'$.routed[0]') AS rule
      FROM projections WHERE collection='events' AND json_extract(data,'$.source')='octo-issue'
      AND json_extract(data,'$.subject')=? ORDER BY json_extract(data,'$.id') DESC LIMIT 12`,
          )
          .all(subject)
          .flatMap(({ type, at, rule }) =>
            typeof type === "string" && typeof at === "string"
              ? [
                  {
                    state: timelineLabel(
                      type.endsWith(".created")
                        ? "Issue 已采集"
                        : type.endsWith(".comment")
                          ? "收到 Issue 评论"
                          : type === "card.answered"
                            ? "收到负责人回复"
                            : "收到后续事件",
                      typeof rule === "string" ? rule : undefined,
                    ),
                    at,
                  },
                ]
              : [],
          ),
        ...runs
          .slice(0, 5)
          .reverse()
          .flatMap<{ state: string; at: string | undefined }>((run) => {
            const created = typeof run.createdAt === "string" ? run.createdAt : undefined;
            const claimed = typeof run.claimedAt === "string" ? run.claimedAt : undefined;
            const finished = typeof run.finishedAt === "string" ? run.finishedAt : undefined;
            const name = (states[String(run.state)] ?? "状态待核对").replace(/^最近一轮/, "执行轮次");
            const labelled = (text: string) => timelineLabel(text, run.rule);
            if (!created && !claimed && !finished) return [{ state: labelled(name), at: undefined }];
            return [
              ...(created ? [{ state: labelled("已入队"), at: created }] : []),
              ...(claimed ? [{ state: labelled("运行中"), at: claimed }] : []),
              ...(finished ? [{ state: labelled(name), at: finished }] : []),
            ];
          }),
      ]
        .sort((a, b) => (a.at ?? "").localeCompare(b.at ?? ""))
        .slice(-12)
    : undefined;
  if (dm && db && !groupAccess) {
    prepareReturnChannel(db);
    db.prepare(
      `INSERT INTO octo_requester_dm VALUES (?,?)
    ON CONFLICT(sender) DO UPDATE SET channel=excluded.channel`,
    ).run(sender, dm);
  }
  return {
    label,
    state,
    publicState: projects ? `${projects.length} 个项目` : publicState,
    ...(projects ? { projects } : latestProgress && { latestProgress }),
    receivedAt: typeof event?.receivedAt === "string" ? event.receivedAt : undefined,
    url: issueUrl(issue.url) ?? issueUrl(event?.link),
    ...(timeline && { timeline }),
  };
}

export function requesterIssues(
  db: DatabaseSync,
  hub: DatabaseSync,
  workspace: string,
  sender: string,
  trackedUid?: string,
) {
  if (!tableExists(db, "octo_intake")) return [];
  const recent = db
    .prepare(
      `SELECT issue, ${intakeFields(db, ["identifier", "assignee_uid", "assignee_name"])}
      FROM octo_intake WHERE state='created' AND sender=? ORDER BY rowid DESC LIMIT 10`,
    )
    .all(sender);
  return recent.flatMap(({ issue, identifier, assignee_uid, assignee_name }) => {
    if (typeof issue !== "string") return [];
    const progress = requesterProgress(db, hub, workspace, sender, issue);
    if (!progress) return [];
    const event = hub
      .prepare(
        `SELECT json_extract(data,'$.summary') AS summary FROM projections
      WHERE collection='events' AND json_extract(data,'$.source')='octo-issue'
      AND json_extract(data,'$.subject')=? AND json_extract(data,'$.type') LIKE '%.created'
      ORDER BY json_extract(data,'$.id') DESC LIMIT 1`,
      )
      .get(`loop:${workspace}:${issue}`);
    const short = typeof event?.summary === "string" ? event.summary.split(" ", 1)[0] : "";
    const label = shortId.test(short)
      ? short
      : typeof identifier === "string" && shortId.test(identifier)
        ? identifier
        : issue;
    const state =
      trackedUid && assignee_uid && assignee_uid !== trackedUid && progress.state === "尚未进入 Hub"
        ? "暂无 Hub 进度（提交时指派给其他人）"
        : progress.state === "尚未进入 Hub"
          ? progress.state
          : (progress.projects?.map(({ rule, state }) => `${rule} · ${state}`).join(" / ") ?? progress.publicState);
    return [{ label, state, ...(typeof assignee_name === "string" && { assignee: assignee_name }) }];
  });
}

export function notification(db: DatabaseSync, id: string, stage: Stage, route?: NoticeRoute) {
  if (!Object.hasOwn(stages, stage)) throw new Error("未知通知节点");
  if (route) {
    const requester = confirmedRequester(db, id, route.intakeChannel);
    if (!requester) throw new Error("找不到唯一的建单人");
    const { sender, url, title } = requester;
    const channel = route.requesterChannel;
    const text = [
      `Issue ${id}：${stages[stage]}。请查看原 Issue。`,
      ...issueTitleLine(title),
      ...(url ? [url] : []),
    ].join("\n");
    return {
      channel,
      sender,
      text,
      send(deliver: (channel: string, text: string) => Promise<string>) {
        return deliverOnce(db, id, stage, () => deliver(channel, text));
      },
    };
  }
  if (!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='octo_requester_dm'").get()) {
    throw new Error("需求方需先在机器人私聊查询一次该 Issue");
  }
  const row = db
    .prepare(
      `SELECT i.url,i.sender,d.channel FROM octo_intake i
    LEFT JOIN octo_requester_dm d ON d.sender=i.sender WHERE i.issue=? AND i.state='created'`,
    )
    .all(id);
  if (row.length !== 1) throw new Error("找不到唯一的建单人");
  const { channel, url, sender } = row[0];
  if (typeof channel !== "string" || !channel) throw new Error("需求方需先在机器人私聊查询一次该 Issue");
  const text = `Issue ${id}：${stages[stage]}。请查看原 Issue。${issueUrl(url) ? `\n${issueUrl(url)}` : ""}`;
  return {
    channel,
    sender: String(sender),
    text,
    send(deliver: (channel: string, text: string) => Promise<string>) {
      return deliverOnce(db, id, stage, () => deliver(channel, text));
    },
  };
}
