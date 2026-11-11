// A machine that already runs a hub or worker must not lose its config when someone mistakenly calls join.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";

const program = path.join(import.meta.dirname, "..", "bin", "agent-autoloop.ts");
const join = (home: string) =>
  spawnSync(
    process.execPath,
    [program, "join", "https://hub.example", "--worker", "remote", "--key", "new-key", "--no-service"],
    {
      env: { ...process.env, AGENT_AUTOLOOP_HOME: home },
      encoding: "utf8",
      timeout: 20_000,
    },
  );

test("join creates a worker configuration on a fresh machine", (t) => {
  const home = mkdtempSync(path.join(tmpdir(), "agent-autoloop-join-new-"));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const result = join(home);
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(readFileSync(path.join(home, "config.json"), "utf8")), {
    url: "https://hub.example",
    worker: { name: "remote", key: "new-key" },
  });
});

for (const [name, config] of [
  ["hub", { url: "http://127.0.0.1:3350", hub: { listen: "127.0.0.1:3350" }, owner: "owner-key" }],
  ["worker", { url: "https://old-hub.example", worker: { name: "existing", key: "old-key" } }],
] as const) {
  test(`join refuses to overwrite an existing ${name} configuration`, (t) => {
    const home = mkdtempSync(path.join(tmpdir(), "agent-autoloop-join-existing-"));
    t.after(() => rmSync(home, { recursive: true, force: true }));
    const file = path.join(home, "config.json");
    const original = JSON.stringify(config, null, 2) + "\n";
    writeFileSync(file, original);
    const result = join(home);
    assert.equal(result.status, 1, result.stderr);
    assert.match(result.stderr, /已经配置过了/);
    assert.equal(readFileSync(file, "utf8"), original);
    assert.ok(existsSync(file));
  });
}
