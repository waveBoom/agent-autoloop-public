// `try` against a real hub, from `init` on. Failure cases: a failure from before this try is reported as this try's, or
// not said at all so it looks as if nothing is going on; a failure of a run that was already waiting isn't reported; a
// question still open from before is missed because no new card comes for it, so try waits out its five minutes.
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { attemptsOf, newFailure } from "../cli/try.ts";

const bin = join(import.meta.dirname, "..", "bin", "agent-autoloop.ts");
const fence = "```";
const ASKS = `#!/bin/sh
cat <<'END'
问了一个问题

${fence}agent-autoloop
{"ask":[{"title":"试跑：选一个颜色","text":"选哪个都行","options":["蓝色","绿色"],"key":"try-color"}]}
${fence}
END
`;
const FAILS = "#!/bin/sh\necho boom >&2\nexit 1\n";

const freePort = () =>
  new Promise<number>((resolve) => {
    const probe = createServer();
    probe.listen(0, "127.0.0.1", () => {
      const { port } = probe.address() as { port: number };
      probe.close(() => resolve(port));
    });
  });

/** A throwaway install running `up`, with this script as its agent and stand-ins for whatever shows a notification. */
async function install(t: { after: (done: () => unknown) => void }, agent: string) {
  const home = mkdtempSync(join(tmpdir(), "agent-autoloop-try-"));
  const standIns = join(home, "stand-ins");
  mkdirSync(standIns);
  for (const name of ["launchctl", "osascript", "notify-send"]) {
    writeFileSync(join(standIns, name), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
  }
  const script = join(home, "agent.sh");
  writeFileSync(script, agent, { mode: 0o755 });
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    AGENT_AUTOLOOP_HOME: home,
    DISPLAY: ":99",
    PATH: `${standIns}:${process.env.PATH}`,
    SHELL: "/bin/sh",
  };
  delete env.AGENT_AUTOLOOP_RULES;
  delete env.AGENT_AUTOLOOP_PUBLIC_URL;
  const program = ["--disable-warning=ExperimentalWarning", bin];
  const port = await freePort();
  const init = spawnSync(
    process.execPath,
    [...program, "init", "--no-service", "--command", script, "--port", String(port)],
    { env, encoding: "utf8", timeout: 30_000 },
  );
  assert.equal(init.status, 0, init.stderr);
  const up = spawn(process.execPath, [...program, "up"], { env, stdio: "ignore" });
  t.after(async () => {
    up.kill("SIGTERM");
    await new Promise((resolve) => up.once("exit", resolve));
    rmSync(home, { recursive: true, force: true });
  });
  const { url } = JSON.parse(readFileSync(join(home, "config.json"), "utf8"));
  for (let i = 0; i < 100; i++) {
    const ready = await fetch(`${url}/healthz`).then(
      (response) => response.ok,
      () => false,
    );
    if (ready) break;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  /** Runs `try` as an Agent would, with nobody at a terminal, and stops it at the limit if it's still going. */
  return (limit: number) =>
    new Promise<{ code: number | null; out: string; err: string; stillGoing: boolean }>((resolve) => {
      const child = spawn(process.execPath, [...program, "try"], { env, stdio: ["ignore", "pipe", "pipe"] });
      let [out, err, stillGoing] = ["", "", false];
      child.stdout.on("data", (chunk) => (out += chunk));
      child.stderr.on("data", (chunk) => (err += chunk));
      const timer = setTimeout(() => {
        stillGoing = true;
        child.kill();
      }, limit);
      child.on("exit", (code) => {
        clearTimeout(timer);
        resolve({ code, out, err, stillGoing });
      });
    });
}

test("a second try finds the question still open from the first", async (t) => {
  const runTry = await install(t, ASKS);
  const first = await runTry(20_000);
  assert.equal(first.code, 0, first.err);
  assert.match(first.out, /#1 试跑：选一个颜色/);
  const second = await runTry(20_000);
  assert.equal(second.stillGoing, false, "it should find the open card, not wait out its five minutes");
  assert.equal(second.code, 0, second.err);
  assert.match(second.out, /#1 试跑：选一个颜色/);
});

test("a failure from before isn't this try's: it says when the retry is and waits for it", async (t) => {
  const runTry = await install(t, FAILS);
  const first = await runTry(20_000);
  assert.equal(first.code, 1);
  assert.match(first.err, /Agent 没跑成：退出码 1：boom/);
  const second = await runTry(4_000);
  assert.equal(second.stillGoing, true, `the old failure ended it: ${second.err}`);
  assert.doesNotMatch(second.out, /开始干活/);
  assert.match(second.out, /上一次没跑成（退出码 1：boom），\d\d:\d\d 会自动再试/);
});

// The retry is minutes away, too long to wait for against a real hub.
test("only a failure since this try started counts", () => {
  const run = (id: number, attempts: number, fields = {}) => ({
    id,
    rule: "试一下",
    state: "queued",
    attempts,
    error: "boom",
    notBefore: "2026-11-04T10:00:00.000Z",
    ...fields,
  });
  const before = attemptsOf([run(1, 1)]);
  assert.equal(newFailure([run(1, 1)], before), undefined, "still waiting for its retry");
  assert.equal(newFailure([run(1, 2)], before)?.id, 1, "it failed again");
  assert.equal(newFailure([run(2, 1)], before)?.id, 2, "a new run failed");
  assert.equal(newFailure([run(3, 0)], before), undefined, "not tried yet");
  assert.equal(newFailure([run(4, 1, { state: "claimed" })], before), undefined, "going again");
  assert.equal(newFailure([run(5, 1, { rule: "别的" })], before), undefined, "another rule");
});
