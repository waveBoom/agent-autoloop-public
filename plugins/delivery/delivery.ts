// One pull request from label to live: review, full check, merge, Ship, health. Every step reads GitHub's state back
// rather than trusting its own last response, and a failure is left for the hub's retry to pick up where it stands.
import { settings, type Live, type Settings } from "./project.ts";
import type { Finding } from "./review.ts";

export type DeliveryIO = {
  api(path: string, body?: any, method?: string): Promise<any>;
  review(pr: any, config: Settings, main: string): Promise<Finding[]>;
  merge(pr: any, config: Settings): Promise<void>;
  disableAuto(number: number): Promise<void>;
  contains(base: string, head: string): Promise<boolean>;
  releaseRequired(base: string, head: string, patterns: string[]): Promise<boolean>;
  live(config: Settings): Promise<Live | null>;
  wait(): Promise<void>;
};
export type Delivered = { summary: string; merged?: string; reviewOnly?: boolean; findings?: Finding[] };

const labels = (pr: any) => new Set<string>((pr.labels ?? []).map((label: any) => label.name));
const newestFirst = (a: any, b: any) => b.id - a.id;

export const status = (io: DeliveryIO, head: string, context: string, state: string, description: string) =>
  io.api(`statuses/${head}`, { state, context, description: [...description].slice(0, 140).join("") }, "POST");

export async function disableAuto(number: number, io: DeliveryIO) {
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      await io.disableAuto(number);
    } catch {
      /* A lost mutation response must be read back, not assumed. */
    }
    try {
      if (!(await io.api(`pulls/${number}`)).auto_merge) return;
    } catch {
      /* Known failure: a failed read-back must still confirm cancellation within three attempts. */
    }
    if (attempt < 2) await io.wait();
  }
  throw new Error("无法确认自动合并已关闭");
}

export async function fullCheck(
  head: string,
  config: Settings,
  io: DeliveryIO,
): Promise<"passed" | "waiting" | "failed"> {
  const { workflow, job } = config.check;
  const query = `head_sha=${head}&event=pull_request&per_page=100`;
  const { workflow_runs: runs } = await io.api(`actions/workflows/${workflow}/runs?${query}`);
  const run = runs.filter((run: any) => run.head_sha === head && run.event === "pull_request").sort(newestFirst)[0];
  if (!run) return "waiting";
  const jobs = (await io.api(`actions/runs/${run.id}/jobs?filter=latest&per_page=100`)).jobs.filter(
    (candidate: any) => candidate.name === job,
  );
  if (!jobs.length) return "waiting";
  if (run.status === "completed" && run.conclusion !== "success") return "failed";
  const finished = (item: any) => item.status === "completed" && item.conclusion === "success";
  return finished(run) && jobs.every(finished) ? "passed" : "waiting";
}

export async function waitLive(merged: string, config: Settings, io: DeliveryIO) {
  if (!config.health) return;
  const query = "branch=main&event=push&per_page=100";
  for (;;) {
    const { workflow_runs } = await io.api(`actions/workflows/${config.ship.workflow}/runs?${query}`);
    const runs = workflow_runs.sort(newestFirst);
    const covering = [];
    for (const run of runs) if (run.event === "push" && (await io.contains(merged, run.head_sha))) covering.push(run);
    const live = await io.live(config);
    if (live) {
      for (const run of covering) {
        if (run.status !== "completed" || run.conclusion !== "success") continue;
        const liveHasIt = await io.contains(run.head_sha, live.sha);
        if (liveHasIt || !(await io.releaseRequired(live.sha, run.head_sha, config.internal))) return;
      }
    }
    const newest = covering[0];
    if (newest?.status === "completed" && newest.conclusion !== "success") {
      throw new Error("已经合并，发布没有通过；修复发布后重交，不要重复提交代码");
    }
    await io.wait();
  }
}

async function clearLabels(number: number, pr: any, io: DeliveryIO) {
  for (const label of ["deliver", "deliver-attended", "deliver-review"]) {
    if (!labels(pr).has(label)) continue;
    try {
      await io.api(`issues/${number}/labels/${label}`, undefined, "DELETE");
    } catch (error) {
      // GitHub returned 404 after an observed labelled PR had already completed Ship; verify the desired state.
      if (labels(await io.api(`pulls/${number}`)).has(label)) throw error;
    }
  }
}

async function synced(number: number, head: string, base: string, io: DeliveryIO) {
  const until = Date.now() + 15 * 60_000;
  for (;;) {
    const pr = await io.api(`pulls/${number}`);
    if (pr.head.sha !== head && (await io.contains(base, pr.head.sha))) return pr;
    if (Date.now() > until) throw new Error("已请求同步 main，15 分钟内没有看到同步后的提交，稍后重试");
    await io.wait();
  }
}

export async function deliver(
  repo: string,
  number: number,
  io: DeliveryIO,
  testLocalHealth = false,
): Promise<Delivered> {
  const reviewOnly = async (pr: any): Promise<Delivered> => {
    const summary = "审查通过，未合并或发布";
    await status(io, pr.head.sha, "delivery", "success", summary);
    await clearLabels(number, pr, io);
    return { summary, reviewOnly: true };
  };
  let pr = await io.api(`pulls/${number}`);
  if (!pr.merged_at && (pr.state !== "open" || !labels(pr).has("deliver"))) return { summary: "没有待交付的标记" };
  if (pr.head.repo?.full_name !== repo || pr.base.ref !== "main") throw new Error("只处理本仓库分支到 main 的合并请求");
  if (pr.auto_merge) await disableAuto(number, io);
  const settingsAt = async (commit: string) => {
    const file = await io.api(`contents/ops/delivery.json?ref=${commit}`);
    const read = settings(JSON.parse(Buffer.from(file.content, "base64").toString("utf8")), testLocalHealth);
    if (read.repo !== repo) throw new Error("main 的 repo 设置与交付仓库不一致");
    return read;
  };
  let config = await settingsAt((await io.api("git/ref/heads/main")).object.sha);
  let head = pr.head.sha;
  await status(io, head, "delivery", "pending", "正在审查、检查和核实发布");
  // Sync inside the run: a thrown sync waits out the hub's growing retry backoff while main keeps moving.
  for (let round = 1; !pr.merged_at; round++) {
    let base = (await io.api("git/ref/heads/main")).object.sha;
    if (!(await io.contains(base, head))) {
      await io.api(`pulls/${number}/update-branch`, { expected_head_sha: head }, "PUT");
      pr = await synced(number, head, base, io);
      head = pr.head.sha;
      await status(io, head, "delivery", "pending", "已同步 main，正在审查、检查和核实发布");
      // GitHub syncs with main as it is by then, which may be newer than what was read above: against the older one, those
      // commits would be reviewed as the branch's own.
      base = (await io.api("git/ref/heads/main")).object.sha;
      if (!(await io.contains(base, head))) {
        if (round < 3) continue;
        throw new Error("main 已前进，稍后重新同步和检查");
      }
    }
    // The settings of the main this round is against: a newer one may add the health check its release has to pass.
    config = await settingsAt(base);
    const findings = await io.review(pr, config, base);
    const current = await io.api(`pulls/${number}`);
    if (current.head.sha !== head) throw new Error("审查期间提交变了，等待重新交付");
    if (findings.length) {
      await status(io, head, "delivery", "failure", "审查发现问题，修复后重新交付");
      return { summary: "审查发现问题，尚未合并", findings };
    }
    if (labels(current).has("deliver-review")) {
      return reviewOnly(current);
    }
    if (current.draft) await io.api(`pulls/${number}/ready`, {}, "POST");
    for (;;) {
      const state = await fullCheck(head, config, io);
      if (state === "failed") throw new Error("完整检查没有通过");
      if (state === "passed") break;
      if ((await io.api(`pulls/${number}`)).head.sha !== head) throw new Error("检查期间提交变了");
      await io.wait();
    }
    pr = await io.api(`pulls/${number}`);
    if (pr.head.sha !== head) throw new Error("要合并的提交没有经过本轮审查");
    if (!pr.merged_at) {
      if (!labels(pr).has("deliver")) return { summary: "交付标记已撤回" };
      if (labels(pr).has("deliver-review")) return reviewOnly(pr);
      if ((await io.api("git/ref/heads/main")).object.sha !== base) {
        if (round < 3) continue;
        throw new Error("main 已前进，稍后重新同步和检查");
      }
      await status(io, head, config.review.status, "success", "此提交审查通过，完整检查通过");
      try {
        await io.merge(pr, config);
      } catch (error) {
        if (!(await io.api(`pulls/${number}`)).merged_at) throw error;
      }
      pr = await io.api(`pulls/${number}`);
      if (!pr.merged_at) throw new Error("尚未确认合并，稍后继续核实");
    }
  }
  await waitLive(pr.merge_commit_sha, config, io);
  const summary = config.health ? "已合并、发布成功，健康版本已核实" : "已合并；项目没有线上服务";
  await status(io, pr.head.sha, "delivery", "success", summary);
  await clearLabels(number, pr, io);
  return { summary, merged: pr.merge_commit_sha };
}
