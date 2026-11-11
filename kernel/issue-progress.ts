import type { SQLInputValue } from "node:sqlite";

type Read = <T>(sql: string, params?: SQLInputValue[]) => T[];
type Round = { rule?: string; state: string; createdAt?: string; claimedAt?: string; finishedAt?: string };
type Disposition = {
  stage?: string;
  stageLabel?: string;
  closed?: number;
  manualLabel?: string;
  latestProgress?: string;
};

export const manualStatusLabels: Record<string, string> = {
  accepted: "已受理",
  planning: "方案中",
  plan_review: "待确认方案",
  coding: "编码中",
  coded: "编码完成",
  test_branch_pushed: "测试分支已推送",
  delivered: "分支已交付 · 待人工测试",
  testing: "已提测",
  released: "已上线",
  followup: "待跟进",
};

export function issueProgress(all: Read, subject: string, rule?: string, accepted = false) {
  const scope = rule === undefined ? "" : " AND json_extract(data,'$.rule')=?";
  const params = rule === undefined ? [subject] : [subject, rule];
  const runs = all<Round>(
    `SELECT json_extract(data,'$.rule') AS rule, json_extract(data,'$.state') AS state, json_extract(data,'$.created_at') AS createdAt,
      json_extract(data,'$.claimed_at') AS claimedAt, json_extract(data,'$.finished_at') AS finishedAt
    FROM projections WHERE collection='runs' AND json_extract(data,'$.lane')=?${scope}
    ORDER BY json_extract(data,'$.id') DESC`,
    params,
  );
  const waiting =
    all(
      `SELECT 1 FROM projections WHERE collection='cards' AND json_extract(data,'$.lane')=?${scope}
    AND json_extract(data,'$.state')='open' AND json_extract(data,'$.kind')='ask' LIMIT 1`,
      params,
    ).length > 0;
  const dispositions = all<Disposition>(
    `SELECT json_extract(data,'$.stage') AS stage, json_extract(data,'$.stageLabel') AS stageLabel,
      json_extract(data,'$.closed') AS closed,
      json_extract(data,'$.manualStatus.label') AS manualLabel,
      json_extract(data,'$.progressNotes[#-1].text') AS latestProgress
    FROM projections WHERE collection='config' AND json_extract(data,'$.subject')=?${scope} LIMIT 2`,
    params,
  );
  const disposition = dispositions.length === 1 ? dispositions[0] : undefined;
  const active = runs.some(({ state }) => state === "claimed" || state === "running");
  let status = "unaccepted";
  let label = "尚未受理";
  if (disposition?.closed === 1) [status, label] = ["closed", "已结案"];
  else if (disposition?.stage && disposition.stageLabel) [status, label] = [disposition.stage, disposition.stageLabel];
  else if (runs.some(({ state }) => state === "unknown")) [status, label] = ["unknown", "状态待核对"];
  else if (active) [status, label] = ["running", "进行中"];
  else if (runs.some(({ state }) => state === "queued")) [status, label] = ["queued", "排队中"];
  else if (waiting) [status, label] = ["waiting", "待确认或回复"];
  else if (disposition?.stage === "testing") [status, label] = ["testing", "提测中"];
  else if (runs.length) [status, label] = ["followup", "待跟进"];
  else if (accepted) [status, label] = ["accepted", "已受理，等待处理"];
  const displayLabel = status === "closed" ? label : (disposition?.manualLabel ?? label);
  return { status, label, displayLabel, latestProgress: disposition?.latestProgress, runs, active, waiting };
}
