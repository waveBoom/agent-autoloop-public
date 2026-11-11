import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { readTestDeliveryProfile } from "../plugins/octo/test-delivery-profile.ts";
import type { Job } from "../protocol/job.ts";

function readGit(dir: string, args: string[]): string {
  const env = Object.fromEntries(Object.entries(process.env).filter(([name]) => !name.startsWith("GIT_")));
  return execFileSync("git", ["--no-optional-locks", "-c", "protocol.ext.allow=never", "-C", dir, ...args], {
    env: { ...env, GIT_NO_LAZY_FETCH: "1", GIT_TERMINAL_PROMPT: "0" },
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    timeout: 10_000,
  });
}

export function pushedTestBranches(rule: Job["rule"], git = readGit): string[] {
  if (!rule.worktrees || !rule.repositories) return [];
  const file = join(rule.cwd.replace(/^~(?=\/)/, homedir()), "test-delivery.json");
  if (!existsSync(file)) return [];
  const { repositories } = readTestDeliveryProfile(file);
  const branches = new Set<string>();
  for (const [alias, binding] of Object.entries(rule.worktrees)) {
    if (git(binding.path, ["status", "--porcelain"]).trim()) return [];
    const head = git(binding.path, ["rev-parse", "--verify", `refs/heads/${binding.branch}^{commit}`]).trim();
    if (head === binding.baseCommit) continue;
    const branch = repositories[alias]?.testBranch;
    if (!branch || branch === rule.repositories[alias]?.baseBranch || branch === binding.branch) return [];
    const ref = `refs/heads/${branch}`;
    const [remoteHead, remoteRef] = git(binding.path, ["ls-remote", "--exit-code", "--refs", "origin", ref])
      .trim()
      .split("\t");
    if (remoteRef !== ref || !/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(remoteHead)) return [];
    git(binding.path, ["merge-base", "--is-ancestor", binding.baseCommit, head]);
    git(binding.path, ["merge-base", "--is-ancestor", head, remoteHead]);
    branches.add(branch);
  }
  return [...branches].sort();
}

export function checkWorktrees(rule: Job["rule"], git = readGit): void {
  for (const [alias, binding] of Object.entries(rule.worktrees ?? {})) {
    const repository = rule.repositories?.[alias];
    if (!repository) throw new Error(`工作区「${alias}」没有对应的仓库声明`);
    const { path, branch, baseCommit } = binding;
    const repo = repository.path.replace(/^~(?=\/)/, homedir());
    const expectedBranch = `branch refs/heads/${branch}`;
    let records: string[][];
    let linked: boolean;
    try {
      records = git(repo, ["worktree", "list", "--porcelain", "-z"])
        .split("\0\0")
        .map((record) => record.split("\0"));
      const top = git(path, ["rev-parse", "--show-toplevel"]).trim();
      const gitDir = git(path, ["rev-parse", "--absolute-git-dir"]).trim();
      const commonDir = git(repo, ["rev-parse", "--path-format=absolute", "--git-common-dir"]).trim();
      linked = top === path && gitDir !== commonDir;
    } catch {
      throw new Error(`无法核实工作区「${alias}」：${path}`);
    }
    const matches = records.filter((record) => record.includes(expectedBranch));
    if (!linked || matches.length !== 1 || matches[0][0] !== `worktree ${path}` || branch === repository.baseBranch)
      throw new Error(`工作区「${alias}」的仓库或任务分支不符合登记：${path}（${branch}）`);
    try {
      const baseRef = binding.baseRef ?? `refs/heads/${repository.baseBranch}`;
      if (![`refs/heads/${repository.baseBranch}`, `refs/remotes/origin/${repository.baseBranch}`].includes(baseRef))
        throw new Error("unexpected base ref");
      git(repo, ["merge-base", "--is-ancestor", baseCommit, baseRef]);
      git(path, ["merge-base", "--is-ancestor", baseCommit, "HEAD"]);
    } catch {
      throw new Error(`工作区「${alias}」无法核实登记的主分支基线：${baseCommit}`);
    }
  }
}
