// Failure modes: stdout contains non-protocol text; unknown tools execute arbitrary endpoints; malformed arguments reach
// the hub; an HTTP failure becomes a successful tool result; notifications get responses; source keys act as owner keys;
// a client is told a version number left behind by a release.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { createServer } from "node:http";
import { versionName } from "../host/version.ts";
import { setup } from "./helpers.ts";
const home = setup("mcp");
test("MCP stdio initializes and exposes only the typed hub operations", async () => {
  const calls: any[] = [];
  const server = createServer((req, res) => {
    calls.push([req.url, req.headers.authorization]);
    res.statusCode = req.url?.includes("999") ? 404 : 200;
    res.end(JSON.stringify({ ok: true }));
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  writeFileSync(
    join(home, "config.json"),
    JSON.stringify({
      url: `http://127.0.0.1:${(server.address() as any).port}`,
      owner: "owner-key",
      source: { name: "app", key: "source-key" },
    }),
  );
  const child = spawn(process.execPath, ["bin/agent-autoloop.ts", "mcp"], {
    cwd: join(import.meta.dirname, ".."),
    env: process.env,
    stdio: ["pipe", "pipe", "pipe"],
  });
  let output = "";
  let err = "";
  child.stdout.on("data", (b) => (output += b));
  child.stderr.on("data", (b) => (err += b));
  const messages = [
    {
      id: 1,
      method: "initialize",
      params: { protocolVersion: "2025-11-25", capabilities: {}, clientInfo: { name: "test", version: "1" } },
    },
    { method: "notifications/initialized" },
    { id: 2, method: "tools/list" },
    { id: 3, method: "tools/call", params: { name: "status", arguments: {} } },
    { id: 4, method: "tools/call", params: { name: "why", arguments: { run: -1 } } },
    { id: 5, method: "tools/call", params: { name: "why", arguments: { run: 999 } } },
    { id: 6, method: "tools/call", params: { name: "request", arguments: { path: "/etc/passwd" } } },
    { id: 7, method: "tools/call", params: { name: "emit", arguments: { id: "a", type: "one" } } },
  ];
  child.stdin.end(messages.map((m) => JSON.stringify({ jsonrpc: "2.0", ...m })).join("\n") + "\n");
  await once(child, "close");
  server.close();
  assert.equal(child.exitCode, 0, err);
  const responses = output
    .trim()
    .split("\n")
    .map((l) => JSON.parse(l));
  assert.equal(responses.length, 7);
  assert.equal(
    responses[0].result.serverInfo.version,
    versionName(),
    "it says which version it is, not a number left behind",
  );
  const get = (id: number) => responses.find((r) => r.id === id);
  assert.equal(get(1).result.protocolVersion, "2025-11-25");
  assert.ok(get(2).result.tools.some((t: any) => t.name === "answer"));
  assert.equal(get(3).result.isError, undefined);
  assert.equal(get(4).error.code, -32602);
  assert.equal(get(5).result.isError, true);
  assert.equal(get(6).error.code, -32602);
  assert.deepEqual(calls, [
    ["/v1/state", "Bearer owner-key"],
    ["/v1/runs/999/why", "Bearer owner-key"],
    ["/v1/events", "Bearer source-key"],
  ]);
});
