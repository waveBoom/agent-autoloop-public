// Each test file runs in its own process with its own home and the fixture rules; modules are imported after this sets
// the environment they read.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after } from "node:test";

export function setup(name: string, rules = "rules.fixture.json") {
  const directory = mkdtempSync(join(tmpdir(), `agent-autoloop-${name}-`));
  process.env.AGENT_AUTOLOOP_HOME = directory;
  process.env.AGENT_AUTOLOOP_RULES = rules.startsWith("/") ? rules : join(import.meta.dirname, rules);
  process.env.AGENT_AUTOLOOP_PUBLIC_URL = "https://hub.test";
  after(() => rmSync(directory, { recursive: true, force: true }));
  return directory;
}

/** A moment in a test's own time, minutes after a fixed start: 10:00 in Asia/Shanghai. */
export const at = (minutes: number) => Date.parse("2026-10-18T02:00:00.000Z") + minutes * 60_000;
