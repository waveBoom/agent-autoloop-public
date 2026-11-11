import { execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { Worktree } from "../kernel/rules.ts";
import type { Job } from "../protocol/job.ts";
import { checkWorktrees } from "./worktrees.ts";

type Binding = Worktree & { repo: string; adopted?: boolean };
type Registration = { branch: string; repositories: Record<string, Binding> };

function git(repo: string, args: string[]) {
  const env = Object.fromEntries(Object.entries(process.env).filter(([name]) => !name.startsWith("GIT_")));
  return execFileSync(
    "git",
    [
      "--no-optional-locks",
      "-c",
      "core.hooksPath=/dev/null",
      "-c",
      "core.fsmonitor=false",
      "-c",
      "submodule.recurse=false",
      "-c",
      "protocol.ext.allow=never",
      "-C",
      repo,
      ...args,
    ],
    {
      encoding: "utf8",
      env: { ...env, GIT_NO_LAZY_FETCH: "1", GIT_TERMINAL_PROMPT: "0" },
      stdio: ["ignore", "pipe", "pipe"],
      timeout: 30_000,
    },
  ).trim();
}

function refExists(repo: string, ref: string): boolean {
  try {
    git(repo, ["show-ref", "--verify", "--quiet", ref]);
    return true;
  } catch (error) {
    if ((error as { status?: number }).status === 1) return false;
    throw error;
  }
}

function pathExists(path: string): boolean {
  try {
    lstatSync(path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

function save(file: string, registration: Registration) {
  const temp = `${file}.${randomUUID()}.tmp`;
  writeFileSync(temp, JSON.stringify(registration), { mode: 0o600, flag: "wx" });
  renameSync(temp, file);
}

function assertNoCheckoutFilters(repo: string) {
  try {
    git(repo, ["config", "--get-regexp", "^filter\\..*\\.(smudge|process)$"]);
  } catch (error) {
    if ((error as { status?: number }).status === 1) return;
    throw error;
  }
  throw new Error("仓库配置了 checkout 过滤器，请先由本人准备并登记工作区");
}

export function prepareIssueWorktrees(job: Job, root: string, now: number): Record<string, Worktree> | undefined {
  if (!job.rule.prepareWorktrees) return job.rule.worktrees;
  const { issueSubject, approvedPlan, approvedRepositories } = job.context;
  const writable = job.rule.planApproval && job.agent.access !== "read" && Boolean(approvedPlan);
  const worktrees = { ...job.rule.worktrees };
  if (!issueSubject) {
    if (writable) throw new Error("准备任务工作区需要事项编号");
    return job.rule.worktrees;
  }
  const id = /^(?:loop:[A-Za-z0-9._-]+:)?(?:issue-)?([A-Za-z0-9][A-Za-z0-9-]{0,79})$/.exec(issueSubject)?.[1];
  if (!id) {
    if (writable) throw new Error("事项编号无法生成安全的任务分支名");
    return job.rule.worktrees;
  }
  const key = createHash("sha256")
    .update(JSON.stringify([job.rule.name, issueSubject]))
    .digest("hex");
  let folder = join(root, key);
  let file = join(folder, "registration.json");
  const existing: Registration | undefined = existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : undefined;
  if (!writable) {
    for (const [alias, binding] of Object.entries(existing?.repositories ?? {})) {
      if (existsSync(binding.path) && !Object.hasOwn(worktrees, alias)) worktrees[alias] = binding;
    }
    return Object.keys(worktrees).length ? worktrees : undefined;
  }
  if (!approvedRepositories?.length) throw new Error("方案未批准任何仓库，请重新提交含仓库范围的方案");
  const requests = approvedRepositories.map((alias) => {
    const repo = job.rule.repositories;
    if (!repo || !Object.hasOwn(repo, alias) || !/^[a-z][a-z0-9-]{0,99}$/.test(alias))
      throw new Error(`没有登记获批仓库「${alias}」`);
    return { alias, repository: repo[alias] };
  });
  const date = new Intl.DateTimeFormat("sv-SE", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  })
    .format(now)
    .replaceAll("-", "");
  const manualBranches = new Set(Object.values(worktrees).map((binding) => binding.branch));
  const issueLink =
    job.context.continuity?.originalIssue?.link ||
    job.context.events.find(({ link }) => /\/fleet\/[^/]+\/issues\//.test(link))?.link;
  const publicId = /^https?:\/\/[^/]+\/fleet\/[^/]+\/issues\/([a-z][a-z0-9]{0,39})-(\d{1,12})\/?(?:[?#].*)?$/i.exec(
    issueLink ?? "",
  );
  const generated = publicId ? `fea_${publicId[1].toUpperCase()}${publicId[2]}` : `fea_issue${id}_${date}`;
  const branch = existing?.branch ?? [...manualBranches][0] ?? generated;
  if (manualBranches.size > 1 || (manualBranches.size && !manualBranches.has(branch)))
    throw new Error("同一事项的仓库须使用同一个任务分支");
  checkWorktrees(job.rule);
  const registration = existing ?? { branch, repositories: {} };
  mkdirSync(folder, { recursive: true, mode: 0o700 });
  folder = realpathSync(folder);
  file = join(folder, "registration.json");
  for (const { alias, repository } of requests) {
    if (Object.hasOwn(worktrees, alias)) continue;
    const repo = realpathSync(repository.path.replace(/^~(?=\/)/, homedir()));
    const bindingPath = registration.repositories[alias];
    const path = bindingPath?.adopted ? bindingPath.path : join(folder, alias);
    const ref = `refs/heads/${branch}`;
    let binding = Object.hasOwn(registration.repositories, alias) ? registration.repositories[alias] : undefined;
    if (binding && (binding.repo !== repo || binding.path !== path || binding.branch !== branch))
      throw new Error(`仓库「${alias}」的工作区登记与当前配置不符`);
    if (!binding) {
      if (pathExists(path) || refExists(repo, ref)) throw new Error(`仓库「${alias}」的任务路径或分支已被占用`);
      const origin = `refs/remotes/origin/${repository.baseBranch}`;
      const local = `refs/heads/${repository.baseBranch}`;
      const remotes = git(repo, ["remote"]).split("\n").filter(Boolean);
      const hasOrigin = remotes.includes("origin");
      if (remotes.length && !hasOrigin) throw new Error(`仓库「${alias}」没有 origin，请确认主分支远端`);
      if (hasOrigin) {
        try {
          git(repo, [
            "fetch",
            "--no-tags",
            "--no-recurse-submodules",
            "--no-write-fetch-head",
            "--no-auto-maintenance",
            "origin",
            `${local}:${origin}`,
          ]);
        } catch {
          throw new Error(`仓库「${alias}」无法拉取 origin/${repository.baseBranch}`);
        }
      }
      const baseRef = hasOrigin ? origin : local;
      const baseCommit = git(repo, ["rev-parse", "--verify", `${baseRef}^{commit}`]);
      binding = { repo, path, branch, baseRef, baseCommit };
      registration.repositories[alias] = binding;
      save(file, registration);
    }
    if (!pathExists(path)) {
      if (binding.adopted) throw new Error(`仓库「${alias}」接管的 App 工作区已移动或删除`);
      assertNoCheckoutFilters(repo);
      if (refExists(repo, ref)) {
        if (git(repo, ["rev-parse", "--verify", ref]) !== binding.baseCommit)
          throw new Error(`仓库「${alias}」的已有任务分支不在已登记基线`);
        git(repo, ["worktree", "add", "--", path, branch]);
      } else {
        git(repo, ["worktree", "add", "-b", branch, "--", path, binding.baseCommit]);
      }
    }
    const { repo: _repo, adopted: _adopted, ...worktree } = binding;
    checkWorktrees({ ...job.rule, worktrees: { [alias]: worktree } });
    worktrees[alias] = worktree;
  }
  return worktrees;
}
