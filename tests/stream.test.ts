// Failure modes: why omits the rule or answer; a stream drops facts at reconnect, exposes key hashes, or permits a source;
// a receipt's rejected actions change on replay; a view write failing after append leaves a partial committed receipt.
// Retrying after a rules edit must keep both versions visible in why.
// Slow stream readers must not load or buffer the entire historical log.
// An already open stream must stop on key revocation and detach its abort listener when cancelled.
// Closing an offline card during heartbeat must wake a channel already polling for that update.
import assert from "node:assert/strict";
import { rows, snapshot } from "../kernel/evolve.ts";
import { after, test } from "node:test";
import { setup } from "./helpers.ts";
setup("stream");
const hub = await import("../host/runtime.ts");
const { makeHandler } = await import("../host/server.ts");
const runtime = makeHandler("test");
after(runtime.close);
const owner = hub.addKey("owner", "me");
const source = hub.addKey("source", "app");
const call = (path: string, key = owner, body?: unknown) =>
  runtime.handle(
    new Request(`http://local${path}`, {
      headers: { authorization: `Bearer ${key}` },
      ...(body !== undefined && { method: "POST", body: JSON.stringify(body) }),
    }),
  );

test("web-standard handler streams facts with cursors and traces an entire run", async () => {
  assert.equal((await call("/v1/stream", source)).status, 401);
  const before = hub.getView().seq;
  hub.ingest("app", { id: "trace", type: "feedback.new" });
  const job = hub.claimNext("w1", "trace")!;
  const result = {
    outcome: "done",
    resolve: [{ card: 999, reason: "越界" }],
    ask: [{ title: "选一个", text: "内容", options: ["甲", "乙"] }],
  };
  const first = hub.finish(job.run, job.token, result);
  assert.deepEqual(hub.finish(job.run, job.token, result).rejected, first.rejected);
  const card = rows(hub.getView(), "cards").find((c) => c.run_id === job.run)!;
  hub.answer(card.id, { choice: 0, by: "本人" });
  const facts = await (await call(`/v1/runs/${job.run}/why`)).json();
  for (const type of ["rules", "ingest", "claimNext", "finish", "answer"])
    assert.ok(
      facts.some((f: any) => f.type === type),
      type,
    );
  const stream = await call(`/v1/stream?after=${before}`);
  const reader = stream.body!.getReader();
  const text = new TextDecoder().decode((await reader.read()).value);
  assert.match(text, new RegExp(`id: ${before + 1}\\n`));
  assert.ok(!text.includes(owner));
  assert.ok(!text.includes(job.token));
  await reader.cancel();
  assert.equal((await call("/v1/stream?after=-1")).status, 400);
});
test("a projection failure rolls back both the receipt and the log", () => {
  hub.ingest("app", { id: "atomic", type: "feedback.new", subject: "atomic" });
  const job = hub.claimNext("w1", "atomic")!;
  const before = snapshot(hub.getView());
  hub.db.exec(
    "CREATE TEMP TRIGGER reject_card BEFORE INSERT ON projections WHEN NEW.collection='cards' BEGIN SELECT RAISE(ABORT,'disk failure'); END;",
  );
  assert.throws(
    () => hub.finish(job.run, job.token, { outcome: "done", notice: [{ title: "通知", text: "内容" }] }),
    /disk failure/,
  );
  hub.db.exec("DROP TRIGGER reject_card");
  assert.deepEqual(snapshot(hub.getView()), before);
  assert.equal(hub.getView().get("runs", job.run)!.state, "claimed");
});

test("why retains each rules version across failed and retried attempts", () => {
  const before = hub.rules;
  const now = Date.now();
  hub.ingest("ops", { id: "versions", type: "alert.raised" }, now);
  const first = hub.claimNext("w2", "versions", now)!;
  hub.finish(first.run, first.token, { outcome: "failed" }, now + 1);
  const changed = structuredClone(before);
  changed.rules[1].prompt = "变更后的规则";
  hub.execute("rules", [changed], now + 2);
  const second = hub.claimNext("w2", "retried", now + 300001)!;
  assert.equal(second.run, first.run);
  const versions = hub.why(first.run).filter((f) => f.type === "rules");
  assert.equal(versions.length, 2);
  hub.execute("rules", [before], now + 300002);
});

test("revoking an owner key closes its active stream before sending another fact", async () => {
  const key = hub.addKey("owner", "temporary");
  const response = await call(`/v1/stream?after=${hub.getView().seq}`, key);
  const reader = response.body!.getReader();
  hub.removeKey("owner", "temporary");
  assert.equal((await reader.read()).done, true);
  await reader.cancel();
});

test("cancelling a stream detaches the request abort listener", async () => {
  const abort = new AbortController();
  const response = await runtime.handle(
    new Request(`http://local/v1/stream?after=${hub.getView().seq}`, {
      headers: { authorization: `Bearer ${owner}` },
      signal: abort.signal,
    }),
  );
  await response.body!.cancel();
  abort.abort();
  await new Promise((resolve) => setImmediate(resolve));
});

test("heartbeat card changes wake pending channel polls", async () => {
  const channel = hub.addKey("channel", "chat");
  const id = hub.createCard({ key: "worker:w2:offline:test", kind: "notice", title: "离线", text: "内容" }).card;
  for (;;) {
    const card = hub.nextCard("chat");
    if (!card) break;
    hub.delivered("chat", card.id, card.version, `message-${card.id}`);
  }
  const abort = new AbortController();
  const timeout = setTimeout(() => abort.abort(), 200);
  try {
    const response = runtime.handle(
      new Request("http://local/v1/cards/next?wait=50", {
        headers: { authorization: `Bearer ${channel}` },
        signal: abort.signal,
      }),
    );
    hub.heartbeat("w2", []);
    const body = await (await response).json();
    assert.equal(body.card?.id, id);
    assert.equal(body.card?.state, "closed");
  } finally {
    clearTimeout(timeout);
    abort.abort();
  }
});

test("a slow subscriber reads only the next fact, not the entire history", async () => {
  const before = hub.getView().seq;
  for (let n = 0; n < 100; n++) hub.ingest("app", { id: `stream-bounded-${n}`, type: "unmatched" });
  const prepare = hub.db.prepare.bind(hub.db);
  let read = 0;
  hub.db.prepare = ((sql: string) => {
    const stmt = prepare(sql);
    if (!/SELECT fact FROM facts/.test(sql)) return stmt;
    return new Proxy(stmt, {
      get(target, key) {
        if (key === "iterate")
          return function* (...args: any[]) {
            for (const row of target.iterate(...args)) {
              read++;
              yield row;
            }
          };
        if (key === "all")
          return (...args: any[]) => {
            const result = target.all(...args);
            read += result.length;
            return result;
          };
        const value = Reflect.get(target, key);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
  }) as typeof hub.db.prepare;
  let response: Response | undefined;
  try {
    response = await call(`/v1/stream?after=${before}`);
    await new Promise((resolve) => setImmediate(resolve));
    assert.ok(read <= 2, `buffered ${read} facts before the subscriber read any`);
    const reader = response.body!.getReader();
    assert.match(new TextDecoder().decode((await reader.read()).value), new RegExp(`id: ${before + 1}\\n`));
    await reader.cancel();
  } finally {
    hub.db.prepare = prepare;
    if (response?.body && !response.body.locked) await response.body.cancel();
  }
});
