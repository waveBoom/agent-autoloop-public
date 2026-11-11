// Being seen. A worker with work in hand asks every second and a channel polls all day; a fact is a disk sync and stays in
// the log for good, so being seen only goes in as often as the judgements on it can use.
// Failure cases: a minute of asking writes a fact per ask, or one per run in hand; an idle worker or a channel, back every
// 50 seconds, writes every time; holding stamps back makes a worker that is there look gone, so a run it keeps reporting goes
// in doubt, it's told as offline, or one missed poll shows it as not online; or makes a worker that is gone look there, so a
// run in the hand of a worker gone quiet goes in doubt instead of waiting for it; a run no longer reported is never judged,
// or judged more than a stamp's lag early; the offline card stays open on the way back, or the run in hand isn't renewed by
// the same ask that brings the worker back; a held-back ask also holds back a claim or a cancel; someone else's run, or a
// run past holding, makes every ask a write or gets stamped; a clock set back leaves a stamp in the future that nothing
// corrects; holding back depends on anything but the time given, or the log no longer replays to the view.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { after, before, test } from "node:test";
import { decide } from "../kernel/decide.ts";
import { empty, evolve, rows, snapshot, type Fact, type View } from "../kernel/evolve.ts";
import { parseRules } from "../protocol/rules.ts";
import { at, setup } from "./helpers.ts";

setup("heartbeat");
const runtime = await import("../host/runtime.ts");
const { serve } = await import("../host/http.ts");

const SECOND = 1000;
const MINUTE = 60 * SECOND;
/** How far behind the last contact a stamp may be, and so how much sooner than its limit a judgement may come. */
const LAG = MINUTE;
const LEASE = 5 * MINUTE;
const OFFLINE = 10 * MINUTE;

const environment = { secret: "test-heartbeat", publicUrl: "https://hub.test" };
const fixture = parseRules(readFileSync(new URL("./rules.fixture.json", import.meta.url), "utf8"), 0, "UTC");
// Without the scheduled rules nothing else comes due, so what the log gains here is down to being seen.
const rules = { ...fixture, rules: fixture.rules.filter((rule) => "source" in rule.when) };

/** The kernel as the shell runs it: each input decided at the current time, and one timer for what comes due. */
class Hub {
  view: View = empty();
  log: Fact[] = [];
  now = at(0);
  constructor() {
    this.act("rules", rules);
  }
  act(type: string, ...args: unknown[]) {
    const decided = decide(this.view, { type, args }, this.now, environment);
    this.log.push(...decided.facts);
    this.view = evolve(this.view, decided.facts);
    return decided.value;
  }
  runTo(time: number) {
    for (let fired = 0; ; fired++) {
      const next = Math.min(Infinity, ...rows(this.view, "due").map((due) => due.at));
      if (next > time) break;
      assert.ok(fired < 100, "a deadline keeps coming due");
      this.now = Math.max(this.now, next);
      this.act("tick");
    }
    this.now = time;
  }
  repeat(every: number, until: number, action: () => void) {
    for (let time = this.now; time < until; time += every) {
      this.runTo(time);
      action();
    }
    this.runTo(until);
  }
  state(run: number) {
    return this.view.get("runs", run)!.state;
  }
  written(type: string) {
    return this.log.filter((fact) => fact.type === type).length;
  }
}

/** A1 belongs to w1 and takes notes three at a time. */
function inHand(hub: Hub, n: number): number {
  hub.act("ingest", "app", { id: `note:${n}`, type: "feedback.new", subject: `#${n}` });
  return hub.act("claimNext", "w1", `claim-${n}`).run;
}
const wentInDoubt = (hub: Hub, run: number) =>
  hub.log.find((fact) =>
    fact.changes.some(({ table, key, row }) => table === "runs" && key === String(run) && row?.state === "unknown"),
  );

test("asking every second with three runs in hand writes one fact a minute", () => {
  const hub = new Hub();
  const runs: number[] = [];
  hub.repeat(SECOND, at(1), () => {
    // Taken on while asking, so stamped at different moments unless a heartbeat brings them together.
    if ((hub.now - at(0)) % (20 * SECOND) === 0) runs.push(inHand(hub, runs.length + 1));
    hub.act("heartbeat", "w1", runs);
  });
  assert.equal(runs.length, 3);
  const before = hub.log.length;
  hub.repeat(SECOND, at(2), () => hub.act("heartbeat", "w1", runs));
  assert.equal(hub.log.length - before, 1, "one minute of asking");
  hub.repeat(SECOND, at(62), () => hub.act("heartbeat", "w1", runs));
  assert.equal(hub.log.length - before, 61, "an hour more of asking");
  assert.ok(hub.log.slice(before).every((fact) => fact.type === "heartbeat"));
});

test("back every 50 seconds with nothing in hand writes every other time, worker or channel", () => {
  const worker = new Hub();
  worker.repeat(50 * SECOND, at(60), () => worker.act("heartbeat", "w1", []));
  assert.equal(worker.written("heartbeat"), 36);
  const channel = new Hub();
  channel.repeat(50 * SECOND, at(60), () => channel.act("channelSeen", "chat"));
  assert.equal(channel.written("channelSeen"), 36);
});

for (const every of [SECOND, 50 * SECOND]) {
  test(`a run reported every ${every / SECOND} seconds stays held, and nobody is told anything`, () => {
    const hub = new Hub();
    const run = inHand(hub, 1);
    hub.repeat(every, at(30), () => hub.act("heartbeat", "w1", [run]));
    assert.equal(hub.state(run), "claimed");
    assert.deepEqual(rows(hub.view, "cards"), []);
    const job = hub.act("claimNext", "w1", "claim-1");
    hub.act("finish", run, job.token, { outcome: "done" });
    assert.equal(hub.state(run), "done");
  });
}

// However a worker's asks fall against its last stamp, the judgement comes from the deadline table alone.
for (const [every, stops] of [
  [SECOND, [0, SECOND, 30 * SECOND, 59 * SECOND]],
  [50 * SECOND, [0, 50 * SECOND]],
] as const) {
  test(`a run no longer reported by a worker back every ${every / SECOND} seconds goes in doubt, told once`, () => {
    for (const stop of stops) {
      const hub = new Hub();
      const run = inHand(hub, 1);
      const other = every === SECOND ? [inHand(hub, 2)] : [];
      let last = 0;
      hub.repeat(every, at(10) + stop, () => {
        last = hub.now;
        hub.act("heartbeat", "w1", [run, ...other]);
      });
      hub.repeat(every, last + 2 * LEASE, () => hub.act("heartbeat", "w1", other));
      assert.equal(hub.state(run), "unknown");
      const judged = wentInDoubt(hub, run)!.at;
      assert.ok(judged > last + LEASE - LAG, `judged ${judged - last} ms after the last report`);
      assert.ok(judged <= last + LEASE + 1, `judged ${judged - last} ms after the last report`);
      const cards = rows(hub.view, "cards");
      assert.deepEqual(
        cards.map((card) => card.key),
        [`run:${run}:unknown`],
      );

      // A worker goes on reporting a run in doubt until it can hand it in: that's being seen, not news about the run.
      hub.runTo(hub.now + LAG);
      const before = hub.log.length;
      const stamp = hub.view.get("runs", run)!.seen_at;
      hub.repeat(SECOND, hub.now + LAG, () => hub.act("heartbeat", "w1", [run, ...other]));
      assert.equal(hub.log.length - before, 1);
      assert.equal(hub.state(run), "unknown");
      assert.equal(hub.view.get("runs", run)!.seen_at, stamp);
    }
  });
}

test("a worker gone with a run in hand keeps the run, is told of once about ten minutes on, and clears on its way back", () => {
  for (const stop of [0, SECOND, 30 * SECOND, 59 * SECOND]) {
    const hub = new Hub();
    const run = inHand(hub, 1);
    let last = 0;
    hub.repeat(SECOND, at(5) + stop, () => {
      last = hub.now;
      hub.act("heartbeat", "w1", [run]);
    });
    hub.runTo(last + 60 * MINUTE);
    assert.equal(wentInDoubt(hub, run), undefined, "gone isn't lost: it may still be working");
    const cards = rows(hub.view, "cards");
    assert.equal(cards.length, 1);
    assert.equal(cards[0].title, "接单程序没连上");
    const told = Date.parse(cards[0].created_at);
    assert.ok(told > last + OFFLINE - LAG, `told ${told - last} ms after the last ask`);
    assert.ok(told <= last + OFFLINE + 1, `told ${told - last} ms after the last ask`);

    const before = hub.log.length;
    hub.act("heartbeat", "w1", [run]);
    assert.equal(hub.log.length, before + 1, "the card, the worker and the run all change in the one fact");
    assert.equal(hub.view.get("cards", cards[0].id)!.state, "closed");
    assert.equal(hub.view.get("runs", run)!.seen_at, new Date(hub.now).toISOString());
    hub.repeat(SECOND, hub.now + 10 * MINUTE, () => hub.act("heartbeat", "w1", [run]));
    assert.equal(hub.state(run), "claimed");
    assert.equal(rows(hub.view, "cards").length, 1);
  }
});

test("a worker away a few minutes and back with the run in hand was never in doubt", () => {
  for (const away of [30 * SECOND, 4 * MINUTE, 9 * MINUTE]) {
    const hub = new Hub();
    const run = inHand(hub, 1);
    const report = () => hub.act("heartbeat", "w1", [run]);
    hub.repeat(SECOND, at(5), report);
    hub.runTo(hub.now + away);
    hub.repeat(SECOND, hub.now + 10 * MINUTE, report);
    assert.equal(hub.state(run), "claimed");
    assert.deepEqual(rows(hub.view, "cards"), []);
  }
});

test("a run reported again is renewed by that very ask, though the worker was seen a moment ago", () => {
  const hub = new Hub();
  const run = inHand(hub, 1);
  hub.repeat(SECOND, at(0) + LEASE - 30 * SECOND, () => hub.act("heartbeat", "w1", []));
  hub.act("heartbeat", "w1", [run]);
  assert.equal(hub.view.get("runs", run)!.seen_at, new Date(hub.now).toISOString());
  hub.repeat(SECOND, at(0) + LEASE + 30 * SECOND, () => hub.act("heartbeat", "w1", [run]));
  assert.equal(hub.state(run), "claimed");
});

test("a worker back without the run it took has that run in doubt straight away", () => {
  const hub = new Hub();
  const run = inHand(hub, 1);
  hub.repeat(SECOND, at(5), () => hub.act("heartbeat", "w1", [run]));
  hub.runTo(hub.now + 20 * MINUTE);
  hub.act("heartbeat", "w1", []);
  hub.runTo(hub.now);
  assert.equal(hub.state(run), "unknown");
});

test("an ask closes an offline card even when nothing else about it is worth writing", () => {
  const hub = new Hub();
  hub.act("heartbeat", "w1", []);
  const { card } = hub.act("createCard", { key: "worker:w1:offline:earlier", kind: "notice", title: "离线", text: "" });
  hub.runTo(hub.now + SECOND);
  hub.act("heartbeat", "w1", []);
  assert.equal(hub.view.get("cards", card)!.state, "closed");
});

test("someone else's run, or one no longer held, is neither stamped nor a reason to write", () => {
  const hub = new Hub();
  hub.act("ingest", "ops", { id: "a", type: "alert.raised", subject: "a" });
  const theirs = hub.act("claimNext", "w2", "theirs").run;
  const finished = inHand(hub, 1);
  const { token } = hub.act("claimNext", "w1", "claim-1");
  hub.act("finish", finished, token, { outcome: "done" });
  const stamps = () => [theirs, finished].map((run) => hub.view.get("runs", run)!);
  const before = stamps();
  hub.runTo(at(2));
  hub.act("heartbeat", "w1", []);
  const written = hub.log.length;
  hub.runTo(hub.now + SECOND);
  hub.act("heartbeat", "w1", [theirs, finished, 999]);
  assert.equal(hub.log.length, written, "nothing of its own was due");
  hub.runTo(hub.now + LAG);
  hub.act("heartbeat", "w1", [theirs, finished, 999]);
  assert.equal(hub.log.length, written + 1, "being seen is due");
  assert.deepEqual(stamps(), before);
});

test("a clock set back corrects the stamps, rather than leaving them in the future", () => {
  const hub = new Hub();
  hub.runTo(at(60));
  const run = inHand(hub, 1);
  hub.act("heartbeat", "w1", [run]);
  hub.act("channelSeen", "chat");
  hub.now = at(0);
  hub.act("heartbeat", "w1", [run]);
  hub.act("channelSeen", "chat");
  const earlier = new Date(at(0)).toISOString();
  assert.equal(hub.view.get("seen", "worker:w1")!.seen_at, earlier);
  assert.equal(hub.view.get("seen", "channel:chat")!.seen_at, earlier);
  assert.equal(hub.view.get("runs", run)!.seen_at, earlier);
});

test("holding back goes by the time given, changes nothing it was given, and the log replays to the view", () => {
  const hub = new Hub();
  const run = inHand(hub, 1);
  hub.act("heartbeat", "w1", [run]);
  const input = { type: "heartbeat", args: ["w1", [run]] };
  const given = structuredClone(input);
  const seen = snapshot(hub.view);
  const decideAt = (time: number) => decide(hub.view, input, time, environment);
  const soon = decideAt(hub.now + LAG - 1);
  const due = decideAt(hub.now + LAG);
  assert.deepEqual(soon.facts, []);
  assert.equal(due.facts.length, 1);
  assert.deepEqual(decideAt(hub.now + LAG - 1), soon);
  assert.deepEqual(decideAt(hub.now + LAG), due);
  assert.deepEqual(input, given);
  assert.deepEqual(snapshot(hub.view), seen);

  hub.repeat(SECOND, hub.now + 5 * MINUTE, () => {
    hub.act("heartbeat", "w1", [run]);
    hub.act("channelSeen", "chat");
  });
  assert.deepEqual(snapshot(evolve(empty(), hub.log)), snapshot(hub.view));
});

test("one missed poll doesn't show a worker or channel as not online; being gone still does", () => {
  const worker = (now: number) => runtime.stateOf(now).agents.find((agent) => agent.worker === "w1")!;
  const channel = (now: number) => runtime.stateOf(now).channels.find((known) => known.id === "chat")!;
  const seen = (now: number) => {
    runtime.heartbeat("w1", [], now);
    runtime.execute("channelSeen", ["chat"], now);
  };
  const missed = at(0) + 100 * SECOND;
  seen(at(0));
  seen(at(0) + 50 * SECOND);
  for (let now = at(0); now < missed + 50 * SECOND; now += 5 * SECOND) {
    assert.equal(worker(now).online, true, `worker ${(now - at(0)) / SECOND} seconds in`);
    assert.equal(channel(now).online, true, `channel ${(now - at(0)) / SECOND} seconds in`);
  }
  const last = missed + 50 * SECOND;
  seen(last);
  assert.equal(worker(last + 2 * MINUTE).online, true);
  assert.equal(channel(last + 2 * MINUTE).online, true);
  assert.equal(worker(last + 2 * MINUTE + LAG + 1).online, false);
  assert.equal(channel(last + 2 * MINUTE + LAG + 1).online, false);
});

const keys = {
  ops: runtime.addKey("source", "ops"),
  w2: runtime.addKey("worker", "w2"),
  chat: runtime.addKey("channel", "chat"),
  owner: runtime.addKey("owner", "owner"),
};
const server = serve(0, "127.0.0.1", { commit: "abc123" });
let base = "";
before(async () => {
  await new Promise((resolve) => server.once("listening", resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
after(() => {
  server.closeAllConnections();
  server.close();
});
async function call(path: string, key: string, body?: unknown) {
  const response = await fetch(base + path, {
    method: body === undefined ? "GET" : "POST",
    headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  assert.equal(response.status, 200, path);
  return response.json();
}
// By type: the hub's own timer can add a fact at any moment, for a worker that isn't asking here.
const beenSeen = () =>
  runtime.one<{ n: number }>(
    "SELECT COUNT(*) AS n FROM facts WHERE json_extract(fact, '$.type') IN ('heartbeat', 'channelSeen')",
  )!.n;

test("polling the doors over and over writes nothing, while a cancel and a new job still come straight through", async () => {
  await call("/v1/cards/next?wait=0", keys.chat);
  let seen = beenSeen();
  for (let n = 0; n < 10; n++) assert.equal((await call("/v1/cards/next?wait=0", keys.chat)).card, null);
  assert.equal(beenSeen(), seen, "an idle channel polling");

  // The alert gives w1 work too. It was last seen on the test's own clock, so its offline deadline would be overdue, and an
  // overdue deadline moves with every input until the timer gets to it.
  runtime.heartbeat("w1", []);
  const ask = (query: string) => call(`/v1/work?wait=0&claim=door&${query}`, keys.w2);
  await call("/v1/events", keys.ops, { id: "door:1", type: "alert.raised", subject: "door" });
  const { job } = await ask("capacity=1");
  assert.equal(job.rule.name, "告警");

  seen = beenSeen();
  for (let n = 0; n < 10; n++) {
    assert.deepEqual(await ask(`capacity=0&running=${job.run}`), { job: null, cancel: [] });
  }
  await call(`/v1/runs/${job.run}/cancel`, keys.owner, {});
  assert.deepEqual(await ask(`capacity=0&running=${job.run}`), { job: null, cancel: [job.run] });
  await call(`/v1/runs/${job.run}/result`, job.token, { outcome: "cancelled" });
  await call("/v1/events", keys.ops, { id: "door:2", type: "alert.raised", subject: "door" });
  const next = await call("/v1/work?wait=0&claim=door-2&capacity=1", keys.w2);
  assert.equal(next.job.rule.name, "告警");
  assert.notEqual(next.job.run, job.run);
  assert.equal(beenSeen(), seen, "a worker asking with a run in hand");
});
