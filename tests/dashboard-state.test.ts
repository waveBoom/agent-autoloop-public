// Failure modes: an owner client loses a card's issue or mistakes a blocked session for ordinary queued work.
import assert from "node:assert/strict";
import { test } from "node:test";
import { stateOf } from "../kernel/state.ts";
import { cardView } from "../kernel/query.ts";
import { rules, World } from "../sim/world.ts";
import { setup } from "./helpers.ts";
import { cardHistory } from "../kernel/query.ts";

test("the owner snapshot exposes blocked original sessions and clears them on retry", async () => {
  setup("dashboard-session-blocked");
  const hub = await import("../host/runtime.ts");
  try {
    hub.execute("rules", [rules], Date.now());
    hub.ingest("app", { id: "original", type: "one", subject: "issue-1" });
    const original = hub.claimNext("w1", "original")!;
    hub.started(original.run, original.token, {
      session: "original-session",
      link: "codex://threads/original-session",
    });
    hub.finish(original.run, original.token, { outcome: "done" });
    hub.execute("retrySession", [original.run], Date.now());
    const retry = hub.claimNext("w1", "retry")!;
    hub.finish(retry.run, retry.token, { outcome: "failed", sessionBlocked: true, error: "原会话仍被占用" });
    assert.equal(hub.stateOf().runs.find(({ id }) => id === retry.run)?.sessionBlocked, true);
    hub.execute("retrySession", [retry.run], Date.now());
    assert.equal(hub.stateOf().runs.find(({ id }) => id === retry.run)?.sessionBlocked, false);
    assert.equal(hub.claimNext("w1", "after-block")?.session, "original-session");
  } finally {
    hub.db.close();
  }
});

test("owner can archive and close an independent approval without creating a run", () => {
  const world = new World();
  try {
    const { card } = world.call("createCard", {
      key: "dashboard-rehearsal",
      kind: "ask",
      title: "审批演练",
      text: "确认范围",
      options: ["确认", "退回"],
    });
    const target = { kind: "card", id: card };
    world.call("issueDisposition", { target, action: "archive" });
    world.call("issueDisposition", { target, action: "close", reason: "演练结束" });
    assert.deepEqual(
      cardHistory(world.view, { id: card }).map(({ id, state, result }) => [id, state, result]),
      [[card, "closed", "演练结束"]],
    );
    world.restart();
    assert.equal(world.view.get("cards", card)?.state, "closed");
    assert.equal(world.view.get("cards", card)?.answer_event, null);
    const key = `issue:task:card:${card}`;
    assert.equal(world.view.get("config", key)?.closed, true);
    assert.equal(world.view.get("config", key)?.archived, true);
    world.call("issueDisposition", { target, action: "restore" });
    assert.equal(world.view.get("config", key)?.archived, false);
    assert.equal(world.view.get("config", key)?.closed, true);
  } finally {
    world.view.close();
  }
});

test("owner state links issue subjects to runs and open cards", () => {
  const run = { id: 90, rule: "one", lane: "issue-90", state: "queued" };
  const card = { id: 1, rule: "one", lane: "issue-1", run_id: 1, kind: "ask", state: "open", options: "[]" };
  const state = stateOf(0, undefined, rules, {
    all: <T>(sql: string): T[] => {
      if (sql.startsWith("SELECT * FROM cards WHERE state =")) return [card] as T[];
      if (sql.startsWith("SELECT * FROM runs")) return [run] as T[];
      if (sql.startsWith("SELECT COUNT(*) AS n FROM events")) return [{ n: 0 }] as T[];
      return [];
    },
    view: (row) => cardView(row, { secret: "test-only", publicUrl: "" }),
    unrouted: () => [],
  });
  assert.deepEqual(
    state.runs.map((row) => [row.id, row.subject]),
    [[90, "issue-90"]],
  );
  assert.deepEqual(
    state.cards.map((row) => [row.id, row.runId, row.subject]),
    [[1, 1, "issue-1"]],
  );
});
