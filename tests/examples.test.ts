// Failure modes: shell examples cross credential boundaries, drop a receipt or forget the delivered version; answering a
// card does not resume its matter; the example exits successfully after an HTTP error; unrelated scheduled work takes the
// example's claim. Only curl, jq and shell builtins run.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test, after } from "node:test";
import { setup } from "./helpers.ts";
import { conformance } from "../protocol/conformance.ts";
const home = setup("examples");
const rules = JSON.parse(readFileSync(process.env.AGENT_AUTOLOOP_RULES!, "utf8"));
rules.rules = rules.rules.filter(({ when }: { when: object }) => "source" in when);
process.env.AGENT_AUTOLOOP_RULES = join(home, "rules.json");
writeFileSync(process.env.AGENT_AUTOLOOP_RULES, JSON.stringify(rules));
const hub = await import("../host/runtime.ts");
const { serve } = await import("../host/http.ts");
const keys = {
  source: hub.addKey("source", "app"),
  worker: hub.addKey("worker", "w1"),
  channel: hub.addKey("channel", "chat"),
  owner: hub.addKey("owner", "me"),
};
const server = serve(0);
await new Promise((resolve) => server.once("listening", resolve));
after(() => {
  server.closeAllConnections();
  server.close();
});
const url = `http://127.0.0.1:${(server.address() as any).port}`;
const shell = (file: string, key: string, extra: Record<string, string> = {}) =>
  new Promise<{ code: number | null; out: string; err: string }>((resolve) => {
    const child = spawn("sh", [`examples/${file}.sh`], {
      cwd: new URL("..", import.meta.url),
      env: { ...process.env, AGENT_AUTOLOOP_URL: url, AGENT_AUTOLOOP_KEY: key, AGENT_AUTOLOOP_ONCE: "1", ...extra },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let out = "";
    let err = "";
    child.stdout.on("data", (b) => (out += b));
    child.stderr.on("data", (b) => (err += b));
    child.on("close", (code) => resolve({ code, out, err }));
  });
test("curl and jq examples run against a conforming hub and complete the answer loop", async () => {
  hub.fixtureClear("schedules");
  hub.tick(Date.now() - 5 * 60_000);
  hub.tick();
  const result = await conformance(url, { keys, eventType: "feedback.new", answerer: "me" });
  assert.ok(result.passed);
  for (const table of ["events", "runs", "run_events", "cards", "deliveries", "timers", "seen"] as const)
    hub.fixtureClear(table);
  hub.ingest("app", { id: "shell", type: "feedback.new", subject: "shell" });
  const receipt = { outcome: "done", summary: "问了", ask: [{ title: "选一个", text: "测试", options: ["甲", "乙"] }] };
  const worker = await shell("worker", keys.worker, {
    AGENT_AUTOLOOP_RECEIPT: JSON.stringify(receipt),
    AGENT_AUTOLOOP_CLAIM: "shell-1",
  });
  assert.equal(worker.code, 0, worker.err);
  const channel = await shell("channel", keys.channel);
  assert.equal(channel.code, 0, channel.err);
  const card = JSON.parse(channel.out);
  assert.equal(card.title, "选一个");
  const answer = await fetch(`${url}/v1/cards/${card.id}/answer`, {
    method: "POST",
    headers: { authorization: `Bearer ${keys.channel}`, "content-type": "application/json" },
    body: JSON.stringify({ choice: 0, by: "me", ref: `curl-${card.id}` }),
  });
  assert.equal(answer.status, 200);
  assert.equal((await shell("worker", keys.worker, { AGENT_AUTOLOOP_CLAIM: "shell-2" })).code, 0);
  assert.notEqual((await shell("worker", keys.channel)).code, 0);
  assert.notEqual((await shell("channel", keys.worker)).code, 0);
});
