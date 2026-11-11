// Failure modes: a comment or restart loses its worktree, another issue sees it, or two issues share a worktree.
import assert from "node:assert/strict";
import { test } from "node:test";
import { parseRules } from "../protocol/rules.ts";
import { World } from "../sim/world.ts";
import { checkWorktrees } from "../worker/worktrees.ts";

test("jobs get only their issue's registered worktrees after replay", () => {
  const world = new World();
  const worktree = { path: "/work/one", branch: "task/one", baseCommit: "a".repeat(40) };
  const config = {
    sources: { app: { name: "任务" } },
    agents: { dev: { name: "开发", worker: "w1", use: "codex", access: "edit" } },
    rules: [
      {
        name: "开发",
        when: { source: "app", types: ["task.created", "task.comment"] },
        to: "dev",
        cwd: "/workflow",
        prompt: "处理",
        parallel: 2,
        planApproval: true,
        repositories: { web: { path: "/repo/web", baseBranch: "main" } },
        issueWorktrees: { one: { web: worktree } },
      },
    ],
  };
  const load = () => parseRules(JSON.stringify(config), 0, "UTC");
  const event = (id: string, type: string, subject: string) => world.call("ingest", "app", { id, type, subject });
  try {
    world.call("rules", load());
    event("created", "task.created", "one");
    const first = world.call("claimNext", "w1", "first");
    assert.deepEqual(first.rule.worktrees, { web: worktree });
    assert.equal(first.rule.cwd, "/workflow");
    assert.equal(first.agent.access, "read");
    event("other", "task.created", "two");
    assert.equal(world.call("claimNext", "w1", "other").rule.worktrees, undefined);
    world.finish(first.run);
    world.restart();
    event("comment", "task.comment", "one");
    assert.deepEqual(world.call("claimNext", "w1", "next").rule.worktrees, { web: worktree });
    Object.assign(config.rules[0].issueWorktrees, { two: { web: worktree } });
    assert.throws(load, /worktree.*重复/);
  } finally {
    world.view.close();
  }
});

test("the worker refuses a wrong branch or a task without the recorded base", () => {
  const root = import.meta.dirname;
  const path = root + "/worktree";
  const baseCommit = "a".repeat(40);
  const rule = {
    name: "开发",
    cwd: root,
    repositories: { web: { path: root + "/repo", baseBranch: "main" } },
    worktrees: { web: { path, branch: "task/one", baseCommit } },
  };
  let branch = "task/one";
  let containsBase = true;
  const git = (dir: string, args: string[]) => {
    if (args[0] === "worktree")
      return `worktree ${root}/repo\0branch refs/heads/main\0\0worktree ${path}\0branch refs/heads/${branch}\0\0`;
    if (args[1] === "--show-toplevel") return dir;
    if (args[0] === "rev-parse") return dir === path ? root + "/repo/.git/worktrees/one" : root + "/repo/.git";
    assert.equal(args[0], "merge-base");
    assert.equal(args[2], baseCommit);
    if (args[3] === "HEAD" && !containsBase) throw new Error("not an ancestor");
    return "";
  };
  assert.doesNotThrow(() => checkWorktrees(rule, git));
  branch = "task/other";
  assert.throws(() => checkWorktrees(rule, git), /任务分支/);
  branch = "task/one";
  containsBase = false;
  assert.throws(() => checkWorktrees(rule, git), /基线/);
});
