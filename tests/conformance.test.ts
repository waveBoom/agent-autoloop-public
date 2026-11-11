// Failure modes: a different hub accepts the wrong key, drops idempotent receipts, loses answers or emits an invalid wire
// object; the address-based conformance runner succeeds against a server that grants every caller access, or an unrelated
// scheduled run takes the work claim intended to verify an answer.
import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { after, beforeEach, test } from "node:test";
import { setup } from "./helpers.ts";
import { conformance } from "../protocol/conformance.ts";
const home = setup("conformance");
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
  owner: hub.addKey("owner", "owner"),
};
const server = serve(0);
await new Promise((resolve) => server.once("listening", resolve));
after(() => {
  server.closeAllConnections();
  server.close();
});
beforeEach(() => {
  for (const table of ["events", "runs", "run_events", "cards", "deliveries", "timers", "seen"] as const)
    hub.fixtureClear(table);
});
const base = `http://127.0.0.1:${(server.address() as any).port}`;
const config = { keys, eventType: "feedback.new", answerer: "me" };
test("address-based conformance checks all protocol doors", async () => {
  hub.fixtureClear("schedules");
  hub.tick(Date.now() - 5 * 60_000);
  hub.tick();
  const result = await conformance(`http://127.0.0.1:${(server.address() as any).port}`, {
    keys,
    eventType: "feedback.new",
    answerer: "me",
  });
  assert.ok(result.checks >= 90);
  console.log(JSON.stringify(result));
});
test("conformance rejects an implementation that opens the wrong door", async () => {
  await assert.rejects(
    () =>
      conformance("http://wrong", { keys, eventType: "feedback.new", answerer: "me" }, async () =>
        Response.json({ ok: true }),
      ),
    /状态码/,
  );
});
test("the same isolated hub can be checked twice", async () => {
  await conformance(base, config);
  await conformance(base, config);
});
test("conformance checks another actual run rather than a missing id", async () => {
  const jobs = new Map<number, string>();
  const wrong: typeof fetch = async (input, init) => {
    const path = new URL(String(input)).pathname;
    const match = /\/runs\/(\d+)\/result/.exec(path);
    const key = new Headers(init?.headers).get("authorization")?.slice(7);
    if (
      match &&
      jobs.has(Number(match[1])) &&
      [...jobs].some(([id, token]) => id !== Number(match[1]) && token === key)
    )
      return Response.json({ rejected: [] });
    const res = await fetch(input, init);
    if (path === "/v1/work") {
      const { job } = await res.clone().json();
      if (job) jobs.set(job.run, job.token);
    }
    return res;
  };
  await assert.rejects(() => conformance(base, config, wrong), /状态码/);
});
for (const mode of ["empty", "keys"] as const)
  test(`conformance rejects ${mode} in the fact stream`, async () => {
    const wrong: typeof fetch = async (input, init) => {
      if (String(input).includes("/v1/stream?after=0"))
        return new Response(
          mode === "empty"
            ? "id: 1\n\n"
            : `id: 1\nevent: fact\ndata: ${JSON.stringify({ version: 1, seq: 1, at: 0, type: "key", changes: [{ table: "keys", key: "owner:owner", row: { hash: "secret-hash" } }] })}\n\n`,
          { headers: { "content-type": "text/event-stream" } },
        );
      return fetch(input, init);
    };
    await assert.rejects(() => conformance(base, config, wrong));
  });
