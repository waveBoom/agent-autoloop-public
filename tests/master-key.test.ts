// The master key signs every card link and run token. Failure modes: an empty or cut-short master.key is used as is, so
// anyone who sees a card's number and time can forge its link; a broken key is quietly replaced, invalidating every
// link and token without the owner deciding to; a good key, with or without a trailing newline, stops being accepted.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { setup } from "./helpers.ts";

const root = setup("master-key");
const runtime = JSON.stringify(new URL("../host/runtime.ts", import.meta.url).href);

const start = (name: string, key?: string) => {
  const home = join(root, name);
  mkdirSync(home);
  if (key !== undefined) writeFileSync(join(home, "master.key"), key, { mode: 0o600 });
  const started = spawnSync(
    process.execPath,
    [
      "--disable-warning=ExperimentalWarning",
      "--input-type=module",
      "-e",
      `const hub = await import(${runtime}); console.log(hub.environment.secret)`,
    ],
    { env: { ...process.env, AGENT_AUTOLOOP_HOME: home }, encoding: "utf8" },
  );
  return { ...started, file: () => readFileSync(join(home, "master.key"), "utf8") };
};

test("an empty or cut-short master key stops the hub and says how to fix it, leaving the file alone", () => {
  for (const [name, key] of [
    ["empty", ""],
    ["blank", "\n"],
    ["half", randomBytes(32).toString("base64url").slice(0, 20)],
    ["not-base64url", "!".repeat(43)],
  ]) {
    const started = start(name, key);
    assert.notEqual(started.status, 0, name);
    assert.match(started.stderr, /master\.key/, name);
    assert.match(started.stderr, /备份/, name);
    assert.equal(started.file(), key, `${name}: not replaced behind the owner's back`);
  }
});

test("a good master key works, with or without a trailing newline; a missing one is made", () => {
  const key = randomBytes(32).toString("base64url");
  for (const [name, written] of [
    ["exact", key],
    ["newline", `${key}\n`],
  ]) {
    const started = start(name, written);
    assert.equal(started.status, 0, started.stderr);
    assert.equal(started.stdout.trim(), key, name);
  }
  const made = start("missing");
  assert.equal(made.status, 0, made.stderr);
  assert.match(made.file(), /^[A-Za-z0-9_-]{43}$/);
  assert.equal(made.stdout.trim(), made.file());
});
