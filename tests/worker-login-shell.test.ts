// Failure modes: an owner whose login shell isn't POSIX (fish) can't start any agent because the worker's command for
// that shell doesn't parse there, or making it parse lets the install path or an argument run as shell source.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";

const scratch = mkdtempSync(join(tmpdir(), "agent-autoloop-login-shell-"));
const home = join(scratch, "quote' $(touch path-injected)");
const project = join(scratch, "project");
mkdirSync(project);
process.env.AGENT_AUTOLOOP_HOME = home;
// A real fish reads its owner's config otherwise.
process.env.HOME = scratch;
process.env.XDG_CONFIG_HOME = join(scratch, "config");
after(() => rmSync(scratch, { recursive: true, force: true }));
const { createWorker } = await import("../worker/worker.ts");

// CI has no fish, so this keeps the two things about it that matter: no $0 or $@, and no arguments reach the command.
const standIn = join(scratch, "not-posix-shell");
writeFileSync(
  standIn,
  `#!/bin/sh
case "$2" in
  *'$0'* | *'$@'*) echo 'not-posix-shell: $@ is not supported' >&2; exit 127 ;;
esac
exec /bin/sh -c "$2"
`,
  { mode: 0o755 },
);
const fish = spawnSync("/bin/sh", ["-c", "command -v fish"], { encoding: "utf8" }).stdout.trim();

const argument = `it's \\ "quoted" $HOME $(touch argv-injected)\nsecond line`;
const waiting: any[] = [];
const results = new Map<number, any>();
const worker = createWorker({
  name: "test",
  wait: 0,
  hub: {
    work: async () => ({ job: waiting.shift() ?? null, cancel: [] }),
    started: async () => ({}),
    result: async (run: number, _token: string, body: unknown) => {
      results.set(run, body);
      return {};
    },
  } as any,
});

async function runUnder(shell: string, run: number) {
  process.env.SHELL = shell;
  waiting.push({
    run,
    token: "test-token",
    attempt: 1,
    session: null,
    askFirst: [],
    rule: { name: "login shell", cwd: project, prompt: "Read the input." },
    agent: { id: "a", name: "Agent", use: "command", access: "edit", command: ["/usr/bin/printf", "%s", argument] },
    context: { events: [], answers: [], timers: [], waiting: [], open: [], decided: [] },
  });
  for (let i = 0; i < 250 && !results.has(run); i++) {
    await worker.tick();
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  assert.equal(results.get(run)?.error, undefined);
  assert.equal(results.get(run)?.outcome, "done");
  assert.equal(readFileSync(join(home, "worker", "runs", `${run}-1`, "stdout-1.log"), "utf8"), argument);
  assert.ok(!existsSync(join(project, "path-injected")), "the install path executed a command");
  assert.ok(!existsSync(join(project, "argv-injected")), "an argument executed a command");
}

test("an agent starts under a login shell without POSIX syntax", () => runUnder(standIn, 1));

test("an agent starts under a real fish", { skip: !fish && "fish isn't installed" }, () => runUnder(fish, 2));
