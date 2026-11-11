import { createHash } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";

export type ChatTurn = { channel: string; channelType?: number; sender: string; message: string; text: string };
export type Draft = { title: string; description: string; questions?: string[] };
export class DraftRequired extends Error {}
type Assignee = { uid: string; name: string };
type Submission = {
  requester: string;
  channel: string;
  message: string;
  draft: Draft;
  reference: string;
  assignee: Assignee;
};
type Issue = { id: string; url?: string; identifier?: string };
type Services = {
  allowed(sender: string): Promise<boolean>;
  resolveAssignee(value: string): Promise<Assignee | undefined>;
  summarize(selected: string): Promise<Draft>;
  checkProject?(content: string): string | undefined;
  create(submission: Submission): Promise<Issue>;
};
type Row = {
  title: string;
  description: string;
  message: string;
  state: "draft" | "sending" | "created";
  issue: string | null;
  url: string | null;
  assignee_uid: string | null;
  assignee_name: string | null;
  identifier: string | null;
};

const pending = "这条请求的建单结果需人工核对。为防重复，系统不会再次提交。";

function issueReply(issue: Issue) {
  return `已创建 Issue，编号：${issue.identifier ?? issue.id}${issue.url ? `\n${issue.url}` : ""}`;
}

export function issueUrl(value: unknown) {
  if (typeof value !== "string") return;
  try {
    const url = new URL(value);
    if (url.protocol === "https:" && !url.username && !url.password) return url.href;
  } catch {}
}

export function issueTitleLine(value: unknown) {
  const title = typeof value === "string" ? value.replace(/\s+/g, " ").trim() : "";
  return title ? [`Issue 标题：${title}`] : [];
}

export function draftFromSelection(selected: string): Draft {
  // Treat submitted text as data. Fleet can interpret mentions as dispatch instructions.
  const description = selected.trim().replace(/[@＠]/g, "[at]");
  const lines = description.split(/\r?\n/).map((line) => line.trim());
  const title = lines.find((line) => line && !/^项目\s*[：:]/.test(line)) ?? "";
  return {
    title: title.replace(/^标题\s*[：:]\s*/, "").slice(0, 150),
    description,
    questions: title ? [] : ["请补充具体目标、现象或预期结果。"],
  };
}

export function intake(db: DatabaseSync, services: Services) {
  db.exec(`CREATE TABLE IF NOT EXISTS octo_intake (
    reference TEXT PRIMARY KEY, channel TEXT NOT NULL, sender TEXT NOT NULL, message TEXT NOT NULL,
    title TEXT NOT NULL, description TEXT NOT NULL, state TEXT NOT NULL DEFAULT 'draft', issue TEXT, url TEXT,
    assignee_uid TEXT, assignee_name TEXT, identifier TEXT
  )`);
  const columns = new Set(
    db
      .prepare("PRAGMA table_info(octo_intake)")
      .all()
      .map((column) => column.name),
  );
  for (const name of ["assignee_uid", "assignee_name", "identifier"]) {
    if (!columns.has(name)) db.exec(`ALTER TABLE octo_intake ADD COLUMN ${name} TEXT`);
  }
  const get = db.prepare("SELECT * FROM octo_intake WHERE reference = ? AND channel = ? AND sender = ?");
  const insert = db.prepare(
    "INSERT OR IGNORE INTO octo_intake (reference,channel,sender,message,title,description,assignee_uid,assignee_name) VALUES (?,?,?,?,?,?,?,?)",
  );
  const claim = db.prepare("UPDATE octo_intake SET state='sending' WHERE reference=? AND state='draft'");
  const finish = db.prepare(
    "UPDATE octo_intake SET state='created', issue=?, url=?, identifier=? WHERE reference=? AND state='sending'",
  );

  return async ({ channel, sender, message, text }: ChatTurn): Promise<string | undefined> => {
    const command = /^\/(提需求|确认提需求)(?:\s+([\s\S]*))?$/.exec(text.trim());
    if (!command) return;
    if (!channel || !sender || !message) return "无法核实这条 Octo 消息的来源。";
    const input = command[2]?.trim() ?? "";
    const confirming = command[1] === "确认提需求";
    const request = confirming ? null : /^指派给[ \t]+([^\r\n]{1,100})\r?\n([\s\S]+)$/.exec(input);
    if (confirming ? !/^[0-9a-f]{24}$/.test(input) : !request?.[2].trim() || request[2].length > 12_000) {
      return confirming
        ? "请复制草稿消息里的完整确认命令。"
        : "请第一行发送 /提需求 指派给 姓名或UID，第二行起填写需求内容，最多 12000 字符。";
    }
    const reference = confirming
      ? input
      : createHash("sha256")
          .update(JSON.stringify([channel, sender, message]))
          .digest("hex")
          .slice(0, 24);
    const read = () => get.get(reference, channel, sender) as Row | undefined;
    let row = read();
    if (confirming && !row) return "找不到你在当前会话提交的草稿。";
    if (!(await services.allowed(sender))) return "只有目标工作区的成员可以提交需求。";

    if (!row) {
      const project = services.checkProject?.(request![2]);
      if (services.checkProject && !project)
        return "还不能确定项目和执行规则。请补一行「项目：规则别名」，并说明目标或现象、影响范围及期望结果，再重新发送 /提需求。";
      const assignee = await services.resolveAssignee(request![1].trim());
      if (!assignee) return "未找到唯一的工作区成员。请核对姓名，重名时请填写 Octo UID。";
      const draft = await services.summarize(request![2].trim());
      if (draft.questions?.length) {
        return [
          "还缺以下信息，补齐后请带原需求一起重新发送 /提需求：",
          ...draft.questions.map((question) => `• ${question}`),
        ].join("\n");
      }
      const title = draft.title.trim();
      const description =
        (project ? `项目：${project}\n\n` : "") + draft.description.replace(/^\s*项目[：:].*$/gm, "").trim();
      if (!title || title.length > 160 || /[\r\n]/.test(title) || !description || description.length > 8_000) {
        return "草稿格式不合适，请缩短或重新选择聊天内容。";
      }
      insert.run(reference, channel, sender, message, title, description, assignee.uid, assignee.name);
      row = read()!;
    }
    if (row.state === "created")
      return issueReply({ id: row.issue!, url: row.url ?? undefined, identifier: row.identifier ?? undefined });
    if (row.state === "sending") return pending;
    if (!row.assignee_uid || !row.assignee_name) return "这份旧草稿缺少指派人，请重新提交需求并指定指派人。";
    if (!confirming)
      return `需求草稿：${row.title}\n指派给：${row.assignee_name}\n\n${row.description}\n\n核对后发送 /确认提需求 ${reference}`;
    if (services.checkProject && !services.checkProject(row.description))
      return "草稿的项目规则无法核实，请补清项目后重新提交。";
    if (!(await services.allowed(row.assignee_uid))) return "指派人已不在该工作区，请重新提交并指定其他成员。";
    if (claim.run(reference).changes !== 1) return pending;

    try {
      const issue = await services.create({
        requester: sender,
        channel,
        message: row.message,
        draft: { title: row.title, description: row.description },
        reference,
        assignee: { uid: row.assignee_uid, name: row.assignee_name },
      });
      if (!issue.id) return pending;
      const url = issueUrl(issue.url);
      finish.run(issue.id, url ?? null, issue.identifier ?? null, reference);
      return issueReply({ id: issue.id, url, identifier: issue.identifier });
    } catch {
      return pending;
    }
  };
}
