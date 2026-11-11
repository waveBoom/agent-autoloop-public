// A delivery may only publish the registered commit and report success after reading it back.
import assert from "node:assert/strict";
import test from "node:test";
import { publishBranches } from "../cli/deliver-octo-branch.ts";

test("short branch delivery verifies the pinned commit and retries without duplicate pushes", () => {
  const branch = "fea_DEMO256";
  const ref = `refs/heads/${branch}`;
  const repositories = { report: { repo: "/repo", path: "/task", branch: "worker-branch", baseCommit: "base" } };
  let remote = "";
  let pushes = 0;
  let canVerify = false;
  const git = (_directory: string, args: string[]) => {
    if (args.includes("--git-common-dir")) return "/repo/.git";
    if (args[0] === "symbolic-ref") return "refs/heads/worker-branch";
    if (args[0] === "status" || args[0] === "merge-base") return "";
    if (args[0] === "rev-parse") return "head";
    if (args[0] === "remote") return "git@example:report.git";
    if (args[0] === "ls-remote") return remote;
    assert.ok(args.includes("push"));
    assert.deepEqual(args.slice(-2), ["origin", `head:${ref}`]);
    pushes++;
    if (canVerify) remote = `head\t${ref}`;
    return "";
  };
  assert.throws(() => publishBranches("DEMO-256", repositories, git), /未通过推送核验/);
  canVerify = true;
  assert.deepEqual(publishBranches("DEMO-256", repositories, git), { branch, commits: ["report head"] });
  publishBranches("DEMO-256", repositories, git);
  assert.equal(pushes, 2);
  remote = `other\t${ref}`;
  assert.throws(() => publishBranches("DEMO-256", repositories, git), /已指向其他提交/);
  assert.equal(pushes, 2);
});
