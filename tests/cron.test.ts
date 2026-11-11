// When a schedule comes next, in the rules' time zone. Failure cases: a malformed schedule is taken; 7 isn't Sunday; a day
// and a weekday both given don't take either; the wall clock is read in the wrong zone; a moment that doesn't exist on the
// day clocks go forward fires at a shifted time, or one that happens twice on the day they go back fires twice; a
// schedule that never comes (February 30) never returns.
import assert from "node:assert/strict";
import { test } from "node:test";
import { describeCron, latestBefore, nextRun, parseCron } from "../kernel/cron.ts";

const next = (text: string, after: string, zone = "Asia/Shanghai") => {
  const at = nextRun(parseCron(text)!, Date.parse(after), zone);
  return at === null ? null : new Date(at).toISOString();
};

test("schedules are parsed strictly", () => {
  for (const bad of [
    "",
    "* * * *",
    "60 * * * *",
    "* 24 * * *",
    "* * 0 * *",
    "* * * 13 *",
    "* * * * 8",
    "a * * * *",
    "5-1 * * * *",
    "*/0 * * * *",
  ]) {
    assert.equal(parseCron(bad), null, bad);
  }
  assert.ok(parseCron("*/5 1,2 1-5 * 0,7"));
});

test("the next time is read in the rules' zone, strictly after the given moment", () => {
  assert.equal(next("0 9 * * *", "2026-10-18T00:59:00Z"), "2026-10-18T01:00:00.000Z");
  assert.equal(next("0 9 * * *", "2026-10-18T01:00:00Z"), "2026-10-19T01:00:00.000Z");
  assert.equal(next("0 9 * * *", "2026-10-18T01:00:00Z", "America/New_York"), "2026-10-18T13:00:00.000Z");
  assert.equal(next("*/5 * * * *", "2026-10-18T01:02:30Z"), "2026-10-18T01:05:00.000Z");
});

test("weekdays and days of the month work as in cron", () => {
  assert.equal(next("0 6 * * 7", "2026-10-18T00:00:00Z"), "2026-10-24T22:00:00.000Z", "Sunday 06:00 in Shanghai");
  assert.equal(next("0 6 * * 0", "2026-10-18T00:00:00Z"), "2026-10-24T22:00:00.000Z");
  // 2026-10-20 is a Tuesday and comes before the 25th: either matches when both are given.
  assert.equal(next("0 0 25 * 2", "2026-10-18T00:00:00Z", "UTC"), "2026-10-20T00:00:00.000Z");
  assert.equal(next("0 0 1 1 *", "2026-10-18T00:00:00Z", "UTC"), "2027-01-01T00:00:00.000Z");
});

test("a moment that doesn't exist is skipped, and one that happens twice runs the first time only", () => {
  // New York, 2026-03-08: 02:30 doesn't exist. 2026-11-01: 01:30 happens twice (05:30Z, then 06:30Z).
  assert.equal(next("30 2 8 3 *", "2026-03-01T00:00:00Z", "America/New_York"), "2027-03-08T07:30:00.000Z");
  assert.equal(next("30 1 1 11 *", "2026-10-31T00:00:00Z", "America/New_York"), "2026-11-01T05:30:00.000Z");
  assert.equal(next("30 1 1 11 *", "2026-11-01T05:30:00Z", "America/New_York"), "2027-11-01T05:30:00.000Z");
});

test("a schedule that never comes says so", () => {
  assert.equal(next("0 0 30 2 *", "2026-01-01T00:00:00Z"), null);
});

test("the latest time due is found across a long gap without walking every minute of it", () => {
  const started = Date.now();
  const latest = latestBefore(
    parseCron("* * * * *")!,
    Date.parse("2020-01-01T00:00:00Z"),
    Date.parse("2026-10-18T01:02:30Z"),
    "UTC",
  );
  assert.equal(new Date(latest).toISOString(), "2026-10-18T01:02:00.000Z");
  assert.ok(Date.now() - started < 1000);
  const monthly = latestBefore(
    parseCron("0 0 1 * *")!,
    Date.parse("2026-07-01T00:00:00Z"),
    Date.parse("2026-10-18T00:00:00Z"),
    "UTC",
  );
  assert.equal(new Date(monthly).toISOString(), "2026-10-01T00:00:00.000Z");
});

test("common schedules read in plain words", () => {
  assert.equal(describeCron("0 18 * * *"), "每天 18:00");
  assert.equal(describeCron("0 6 * * 0"), "每周日 06:00");
  assert.equal(describeCron("0 9 * * 1-5"), "工作日 09:00");
  assert.equal(describeCron("0 4 1 * *"), "每月 1 日 04:00");
  assert.equal(describeCron("*/5 * * * *"), "*/5 * * * *");
});
