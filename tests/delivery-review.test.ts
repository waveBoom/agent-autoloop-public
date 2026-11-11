// A deployment receipt or a stale card must never release a requester notification.
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { deliveryReview, reviewCardKey } from "../plugins/octo/delivery-review.ts";

test("only the configured approver on the bound card releases one notification for the deployed version", async () => {
  using db = new DatabaseSync(":memory:");
  const review = deliveryReview(db, { issue: "issue-1", version: "sim-1", environment: "test", approver: "owner" });
  assert.equal(review.read().state, "deployed");
  const answer = {
    id: 4,
    key: reviewCardKey("issue-1", "sim-1"),
    state: "decided",
    choice: 0,
    by: "owner",
    answer_event: 8,
  };
  assert.equal(review.recordDecision(answer), false);
  assert.equal(review.claimCard(), true);
  assert.equal(review.claimCard(), false);
  review.bindCard(4, "native:123");
  assert.equal(review.recordDecision({ ...answer, by: "other" }), false);
  assert.equal(review.recordDecision({ ...answer, key: reviewCardKey("issue-1", "sim-0") }), false);
  let calls = 0;
  const send = async () => {
    calls++;
    return "notice-1";
  };
  assert.equal(await review.notify(send), undefined);
  assert.equal(review.recordDecision(answer), true);
  const results = await Promise.all([review.notify(send), review.notify(send)]);
  assert.ok(results.includes("notice-1"));
  assert.equal(await review.notify(send), "notice-1");
  assert.equal(calls, 1);
  assert.equal(review.read().state, "notified");
});

test("a return cannot send, and an uncertain send is kept for reconciliation", async () => {
  using db = new DatabaseSync(":memory:");
  const deployment = { issue: "issue-1", version: "sim-1", environment: "test", approver: "owner" };
  const review = deliveryReview(db, deployment);
  review.claimCard();
  review.bindCard(4, "native:123");
  const answer = {
    id: 4,
    key: reviewCardKey("issue-1", "sim-1"),
    state: "decided",
    choice: 1,
    by: "owner",
    answer_event: 8,
  };
  assert.equal(review.recordDecision(answer), true);
  assert.equal(review.read().state, "returned");
  assert.equal(await review.notify(async () => assert.fail()), undefined);
  const next = deliveryReview(db, { ...deployment, version: "sim-2" });
  next.claimCard();
  next.bindCard(5, "native:456");
  assert.equal(next.recordDecision(answer), false);
  assert.equal(next.recordDecision({ ...answer, id: 5, key: reviewCardKey("issue-1", "sim-2"), choice: 0 }), true);
  await assert.rejects(
    next.notify(async () => {
      throw Error("response lost");
    }),
  );
  assert.equal(next.read().state, "notification_uncertain");
  assert.equal(await next.notify(async () => assert.fail()), undefined);
});
