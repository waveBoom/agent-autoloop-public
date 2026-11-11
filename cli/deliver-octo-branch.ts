import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { readConfig } from "../host/config.ts";
import { HOME } from "../host/home.ts";
import { hubClient } from "../protocol/client.ts";

type Binding = { repo: string; path: string; branch: string; baseCommit: string };
type Git = (directory: string, args: string[]) => string;

const git: Git = (directory, args) => {
  const env = Object.fromEntries(Object.entries(process.env).filter(([name]) => !name.startsWith("GIT_")));
  return execFileSync(
    "git",
    [
      "--no-optional-locks",
      "-c",
      "core.hooksPath=/dev/null",
      "-c",
      "protocol.ext.allow=never",
      "-C",
      directory,
      ...args,
    ],
    { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: 60_000, env: { ...env, GIT_TERMINAL_PROMPT: "0" } },
  ).trim();
};

export function publishBranches(issue: string, repositories: Record<string, Binding>, runGit = git) {
  if (!/^[A-Z]+-\d+$/.test(issue)) throw new Error("无法生成安全的 Octo 交付分支名");
  const branch = `fea_${issue.replace("-", "")}`;
  const ref = `refs/heads/${branch}`;
  const targets = Object.entries(repositories).flatMap(([name, binding]) => {
    const { repo, path, baseCommit } = binding;
    if (
      runGit(path, ["rev-parse", "--path-format=absolute", "--git-common-dir"]) !==
        runGit(repo, ["rev-parse", "--path-format=absolute", "--git-common-dir"]) ||
      runGit(path, ["symbolic-ref", "HEAD"]) !== `refs/heads/${binding.branch}` ||
      binding.branch === branch ||
      runGit(path, ["status", "--porcelain"])
    )
      throw new Error(`仓库「${name}」的任务工作区未就绪，请先提交改动并核对登记分支`);
    const head = runGit(path, ["rev-parse", "--verify", "HEAD^{commit}"]);
    runGit(path, ["merge-base", "--is-ancestor", baseCommit, head]);
    if (head === baseCommit) return [];
    const origin = runGit(repo, ["remote", "get-url", "origin"]);
    if (runGit(repo, ["remote", "get-url", "--push", "--all", "origin"]) !== origin)
      throw new Error(`仓库「${name}」的 origin 推送地址与读取地址不一致`);
    const remote = runGit(repo, ["ls-remote", "--refs", "origin", ref]);
    const expected = `${head}\t${ref}`;
    if (remote && remote !== expected) throw new Error(`仓库「${name}」的 origin/${branch} 已指向其他提交`);
    return [{ name, repo, head, remote, expected }];
  });
  if (!targets.length) throw new Error("登记工作区没有可交付的提交");
  for (const { name, repo, head, remote, expected } of targets) {
    try {
      if (!remote)
        runGit(repo, [
          "-c",
          "remote.origin.mirror=false",
          "push",
          "--no-follow-tags",
          "--recurse-submodules=no",
          "--push-option=ci.skip",
          "origin",
          `${head}:${ref}`,
        ]);
      if (runGit(repo, ["ls-remote", "--refs", "origin", ref]) !== expected) throw new Error();
    } catch {
      throw new Error(
        `仓库「${name}」的 origin/${branch} 未通过推送核验。卡片仍待处理，可重跑同一命令核对已推送的分支。`,
      );
    }
  }
  return { branch, commits: targets.map(({ name, head }) => `${name} ${head}`) };
}

export async function deliverOctoBranch(args: string[]) {
  const [raw, ...extra] = args;
  const card = Number(raw);
  if (!/^[1-9]\d*$/.test(raw ?? "") || !Number.isSafeInteger(card) || extra.length)
    throw new Error("用法：agent-autoloop octo deliver <待处理的交付卡号>");
  const config = readConfig();
  if (!config.hub || !config.owner) throw new Error("请在 Hub 本机以本人身份执行交付");
  using db = new DatabaseSync(join(HOME, "hub.db"), { readOnly: true });
  const row = db
    .prepare(
      `
    SELECT json_extract(data,'$.rule') AS rule, json_extract(data,'$.lane') AS lane,
           json_extract(data,'$.source_title') AS title
    FROM projections WHERE collection='cards' AND json_extract(data,'$.id')=?
      AND json_extract(data,'$.state')='open' AND json_extract(data,'$.kind')='ask'
      AND json_extract(data,'$.source')='octo-issue' AND NOT json_extract(data,'$.plan_approval') IS TRUE
  `,
    )
    .get(card);
  const issue = typeof row?.title === "string" && /^([A-Z]+-\d+)(?=\s|$)/.exec(row.title)?.[1];
  if (!issue || !row?.rule || typeof row.lane !== "string" || !row.lane.startsWith("loop:"))
    throw new Error("找不到待处理的 Octo 交付卡，或该卡是方案审批卡");
  if (
    db
      .prepare(
        `
    SELECT 1 FROM projections WHERE collection='runs' AND json_extract(data,'$.rule')=?
      AND json_extract(data,'$.lane')=? AND json_extract(data,'$.state') IN ('queued','claimed','unknown')
  `,
      )
      .get(row.rule, row.lane)
  )
    throw new Error("该 Issue 还有未结束的执行轮次");
  const key = createHash("sha256")
    .update(JSON.stringify([row.rule, row.lane]))
    .digest("hex");
  const registration = JSON.parse(readFileSync(join(HOME, "worker", "worktrees", key, "registration.json"), "utf8"));
  const { branch, commits } = publishBranches(issue, registration.repositories);
  const note = `${issue} 代码已推送并核验。远程分支 ${branch}，提交 ${commits.join("、")}。等待人工测试。`;
  if (typeof row.rule !== "string") throw new Error("无法识别交付规则");
  const result = await hubClient(config.url, config.owner).issueDisposition({
    rule: row.rule,
    subject: row.lane,
    action: "delivered",
    card,
    reason: note,
  });
  if (!result?.ok) throw new Error(`远程分支已核验，但未确认 Hub 交付状态，请核对卡片 #${card}。`);
  console.log(note);
}
