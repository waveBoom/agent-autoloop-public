import { createHash } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";

type Deployment = { issue: string; version: string; environment: string; approver: string };
type Decision = {
  id: number;
  key?: string;
  state: string;
  choice?: number | null;
  by?: string | null;
  answer_event?: number;
};
type Review = {
  id: number;
  state:
    | "deployed"
    | "card_sending"
    | "awaiting_confirmation"
    | "confirmed"
    | "returned"
    | "notifying"
    | "notified"
    | "notification_uncertain";
  card: number | null;
  card_ref: string | null;
  notification_ref: string | null;
};

export const reviewCardKey = (issue: string, version: string) =>
  `delivery-review:${createHash("sha256")
    .update(JSON.stringify([issue, version]))
    .digest("hex")}`;

export function deliveryReview(db: DatabaseSync, { issue, version, environment, approver }: Deployment) {
  if (![issue, version, environment, approver].every((part) => part.trim())) throw new Error("部署回执缺少必要字段");
  db.exec(`CREATE TABLE IF NOT EXISTS octo_delivery_review (
    id INTEGER PRIMARY KEY, issue TEXT NOT NULL, version TEXT NOT NULL, environment TEXT NOT NULL,
    approver TEXT NOT NULL, state TEXT NOT NULL, card INTEGER UNIQUE, card_ref TEXT,
    answer_event INTEGER, notification_ref TEXT, UNIQUE (issue, version)
  )`);
  db.exec("BEGIN IMMEDIATE");
  let id: number;
  try {
    const existing = db
      .prepare("SELECT id, environment, approver FROM octo_delivery_review WHERE issue=? AND version=?")
      .get(issue, version);
    if (existing) {
      if (existing.environment !== environment || existing.approver !== approver)
        throw new Error("已有部署回执与本次记录不符");
      id = Number(existing.id);
    } else {
      const latest = db
        .prepare("SELECT state FROM octo_delivery_review WHERE issue=? ORDER BY id DESC LIMIT 1")
        .get(issue);
      if (latest && latest.state !== "returned" && latest.state !== "notified")
        throw new Error("该 Issue 的前一版本尚未处理完");
      id = Number(
        db
          .prepare(
            "INSERT INTO octo_delivery_review (issue,version,environment,approver,state) VALUES (?,?,?,?,'deployed')",
          )
          .run(issue, version, environment, approver).lastInsertRowid,
      );
    }
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
  const latest = "id=(SELECT max(id) FROM octo_delivery_review WHERE issue=?)";
  const read = () =>
    db.prepare("SELECT id,state,card,card_ref,notification_ref FROM octo_delivery_review WHERE id=?").get(id) as Review;
  const move = (from: Review["state"], to: Review["state"]) =>
    db.prepare(`UPDATE octo_delivery_review SET state=? WHERE id=? AND state=? AND ${latest}`).run(to, id, from, issue)
      .changes === 1;
  return {
    read,
    claimCard: () => move("deployed", "card_sending"),
    bindCard(card: number, ref: string) {
      if (!Number.isSafeInteger(card) || card <= 0 || !/^native:[1-9]\d*$/.test(ref)) throw new Error("审批卡回执无效");
      const result = db
        .prepare(
          `UPDATE octo_delivery_review SET card=?,card_ref=?,state='awaiting_confirmation'
        WHERE id=? AND state='card_sending' AND ${latest}`,
        )
        .run(card, ref, id, issue);
      if (result.changes !== 1) throw new Error("审批卡未绑定到当前部署版本");
    },
    recordDecision(answer: Decision) {
      if (
        answer.key !== reviewCardKey(issue, version) ||
        answer.state !== "decided" ||
        answer.by !== approver ||
        (answer.choice !== 0 && answer.choice !== 1) ||
        !Number.isSafeInteger(answer.answer_event) ||
        !answer.answer_event
      )
        return false;
      return (
        db
          .prepare(
            `UPDATE octo_delivery_review SET state=?,answer_event=?
        WHERE id=? AND card=? AND state='awaiting_confirmation' AND ${latest}`,
          )
          .run(answer.choice === 0 ? "confirmed" : "returned", answer.answer_event, id, answer.id, issue).changes === 1
      );
    },
    async notify(send: () => Promise<string>) {
      if (!move("confirmed", "notifying")) return read().notification_ref ?? undefined;
      try {
        const ref = await send();
        if (!ref) throw new Error("未收到通知回执");
        db.prepare(
          "UPDATE octo_delivery_review SET state='notified',notification_ref=? WHERE id=? AND state='notifying'",
        ).run(ref, id);
        return ref;
      } catch (error) {
        move("notifying", "notification_uncertain");
        throw error;
      }
    },
  };
}
