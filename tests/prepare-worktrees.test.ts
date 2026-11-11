// Failure modes: preparation writes before approval, branches from the checkout, or loses its name after a partial run.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { Job } from "../protocol/job.ts";
import { prepareIssueWorktrees } from "../worker/prepare-worktrees.ts";

test("approved preparation uses recorded main commits and shares a branch across retry and repositories", (t) => {
  const fixture = realpathSync(mkdtempSync(join(tmpdir(), "autoloop-worktrees-")));
  t.after(() => rmSync(fixture, { recursive: true, force: true }));
  const git = (dir: string, ...args: string[]) =>
    execFileSync(
      "git",
      [
        "-C",
        dir,
        "-c",
        "core.hooksPath=/dev/null",
        "-c",
        "commit.gpgsign=false",
        "-c",
        "user.name=Test",
        "-c",
        "user.email=test@example.invalid",
        ...args,
      ],
      { stdio: ["ignore", "pipe", "pipe"], encoding: "utf8" },
    ).trim();
  const repository = (name: string, hasMain: boolean) => {
    const path = join(fixture, name);
    mkdirSync(path);
    git(path, "init", "-b", "main");
    writeFileSync(join(path, "file"), "main");
    git(path, "add", "file");
    git(path, "commit", "-m", "main");
    const localMain = git(path, "rev-parse", "HEAD");
    git(path, "switch", "-c", "upstream-fixture");
    git(path, "commit", "--allow-empty", "-m", "remote main");
    const base = git(path, "rev-parse", "HEAD");
    const origin = join(fixture, `${name}-origin.git`);
    git(path, "clone", "--bare", "--branch", "upstream-fixture", "--", path, origin);
    git(path, "remote", "add", "origin", origin);
    if (hasMain) git(origin, "update-ref", "refs/heads/main", base);
    else git(origin, "branch", "-m", "main", "offline-main");
    git(path, "switch", "-c", "unrelated", localMain);
    git(path, "commit", "--allow-empty", "-m", "unrelated");
    return { path, base, localMain, origin };
  };
  const web = repository("web", true);
  const api = repository("api", false);
  const registry = join(fixture, "registry");
  const job: Job = {
    run: 1,
    token: "test",
    attempt: 1,
    session: null,
    askFirst: [],
    rule: {
      name: "联合任务",
      cwd: fixture,
      planApproval: true,
      prepareWorktrees: true,
      repositories: { web: { path: web.path, baseBranch: "main" }, api: { path: api.path, baseBranch: "main" } },
    },
    agent: { id: "codex", name: "Codex", use: "codex", access: "read" },
    context: {
      issueSubject: "loop:workspace:issue-123",
      continuity: {
        originalIssue: {
          summary: "任务",
          detail: "",
          link: "https://octo.example.invalid/fleet/demo-workspace/issues/DEMO-257",
        },
        recentRuns: [],
        recentInputs: [],
        recentDecisions: [],
      },
      events: [],
      answers: [],
      timers: [],
      waiting: [],
      open: [],
      decided: [],
    },
  };
  const now = Date.parse("2026-11-08T02:00:00Z");
  assert.equal(prepareIssueWorktrees(job, registry, now), undefined);
  assert.equal(existsSync(registry), false);
  job.agent.access = "edit";
  job.context.approvedPlan = "修改 web 和 api";
  job.context.approvedRepositories = ["web", "api"];
  assert.throws(() => prepareIssueWorktrees(job, registry, now), /origin\/main/);
  assert.equal(git(web.path, "rev-parse", "fea_DEMO257"), web.base);
  assert.equal(git(web.path, "branch", "--show-current"), "unrelated");
  assert.equal(git(web.path, "rev-parse", "main"), web.localMain);
  git(api.origin, "update-ref", "refs/heads/main", api.base);
  const bindings = prepareIssueWorktrees(job, registry, now + 86400000)!;
  assert.equal(bindings.web.branch, "fea_DEMO257");
  assert.equal(bindings.api.branch, bindings.web.branch);
  assert.equal(git(bindings.api.path, "rev-parse", "HEAD"), api.base);
  assert.deepEqual(prepareIssueWorktrees(job, registry, now + 172800000), bindings);
  job.agent.access = "read";
  delete job.context.approvedPlan;
  delete job.context.approvedRepositories;
  assert.equal(prepareIssueWorktrees(job, registry, now)!.web.path, bindings.web.path);
});
