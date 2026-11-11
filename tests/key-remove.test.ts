// Failure modes: a source revokes somebody else's key; a revoked key keeps a pending poll or stream alive; CLI writes
// a different database instead of revoking through the running hub; a key named the way `key new` allows cannot be
// revoked; removing a key that was never there is reported as if the key was revoked.
import assert from "node:assert/strict";
import { after, test } from "node:test";
import { setup } from "./helpers.ts";
setup("key-remove");
const hub = await import("../host/runtime.ts");
const { makeHandler } = await import("../host/server.ts");
const runtime = makeHandler();
after(runtime.close);
const owner = hub.addKey("owner", "me");
const worker = hub.addKey("worker", "w1");
const source = hub.addKey("source", "app");
const request = (path: string, key: string, method = "GET") =>
  runtime.handle(
    new Request("http://local" + path, {
      method,
      headers: { authorization: `Bearer ${key}` },
      signal: AbortSignal.timeout(2000),
    }),
  );
test("a name `key new` allows can be revoked, and removal says whether it was there", async () => {
  const name = "MacBook_prod.2";
  const key = hub.addKey("source", name);
  const path = `/v1/keys/source/${encodeURIComponent(name)}`;
  assert.equal((await request(path, source, "DELETE")).status, 401);
  assert.deepEqual(await (await request(path, owner, "DELETE")).json(), { ok: true, changed: true });
  assert.equal((await request("/v1/events", key, "POST")).status, 401);
  assert.deepEqual(await (await request(path, owner, "DELETE")).json(), { ok: true, changed: false });
  assert.equal(hub.removeKey("source", "never-there"), false);
  assert.equal((await request("/v1/keys/source/%zz", owner, "DELETE")).status, 400);
  const long = "a".repeat(201);
  const longKey = hub.addKey("source", long);
  assert.deepEqual(await (await request(`/v1/keys/source/${long}`, owner, "DELETE")).json(), {
    ok: true,
    changed: true,
  });
  assert.equal((await request("/v1/events", longKey, "POST")).status, 401);
});

test("only the owner removes keys and pending work is refused immediately", async () => {
  assert.equal((await request("/v1/keys/worker/w1", source, "DELETE")).status, 401);
  const waiting = request("/v1/work?claim=pending&wait=50", worker);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal((await request("/v1/keys/worker/w1", owner, "DELETE")).status, 200);
  assert.equal((await waiting).status, 401);
  assert.equal((await request("/v1/work?claim=next&wait=0", worker)).status, 401);
  const response = await request(`/v1/stream?after=${hub.getView().seq}`, owner);
  const reader = response.body!.getReader();
  assert.equal((await request("/v1/keys/owner/me", owner, "DELETE")).status, 200);
  assert.equal((await reader.read()).done, true);
});
