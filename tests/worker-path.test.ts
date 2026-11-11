// Failure modes: characters in the install path execute as shell source, command arguments are re-parsed,
// or the worker cannot recover the result from a directory containing quotes and command substitutions.
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";

const scratch = mkdtempSync(join(tmpdir(), "agent-autoloop-worker-path-"));
const home = join(scratch, "quote' $(touch path-injected)");
const project = join(scratch, "project");
mkdirSync(project);
process.env.AGENT_AUTOLOOP_HOME = home;
process.env.SHELL = "/bin/sh";
after(() => rmSync(scratch, { recursive: true, force: true }));
const { createWorker } = await import("../worker/worker.ts");

test("install paths and command arguments stay literal through the worker wrapper", async () => {
  const results: any[] = [];
  let claimed = false;
  const job = {
    run: 1,
    token: "test-token",
    attempt: 1,
    session: null,
    askFirst: [],
    rule: { name: "literal", cwd: project, prompt: "Read the input." },
    agent: {
      id: "a",
      name: "Agent",
      use: "command",
      access: "edit",
      command: ["echo", "literal $(touch argv-injected)"],
    },
    context: { events: [], answers: [], timers: [], waiting: [], open: [], decided: [] },
  };
  const worker = createWorker({
    name: "test",
    wait: 0,
    hub: {
      work: async () => {
        const next = claimed ? null : job;
        claimed = true;
        return { job: next, cancel: [] };
      },
      started: async () => ({}),
      result: async (_run: number, _token: string, body: unknown) => {
        results.push(body);
        return {};
      },
    } as any,
  });
  for (let i = 0; i < 100 && !results.length; i++) {
    await worker.tick();
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  assert.ok(!existsSync(join(project, "path-injected")), "the install path executed a command");
  assert.ok(!existsSync(join(project, "argv-injected")), "an argument executed a command");
  assert.equal(results[0]?.summary, "literal $(touch argv-injected)");
  assert.equal(results[0]?.outcome, "done");
});
