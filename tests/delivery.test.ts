// Failure modes: missing labels/forks dispatch; draft or skipped checks authorize merging; a push
// during review or main advancing after checks gets an unreviewed attestation; a dropped merge is repeated; auto-merge
// survives a refusal; health hides a failed/unfinished Ship; a later release changes an already completed handoff;
// a successful label deletion with a lost response turns a completed deployment into a false failure;
// switching to review-only while checks run still merges the PR; a PR behind main ends the run after requesting a
// sync and waits out the hub's growing retry delay while main keeps moving; commits GitHub synced beyond the main that was
// read are reviewed as the branch's own; a delivery withdrawn while main moves on still syncs and reviews again; settings read
// before main moved decide what a round against the newer main does, so a health check added there is skipped.
import assert from "node:assert/strict";
import { test } from "node:test";
import { deliver, fullCheck, waitLive, disableAuto, type DeliveryIO } from "../plugins/delivery/delivery.ts";
import { settings } from "../plugins/delivery/project.ts";
const config = settings({
  repo: "example/app",
  internal: ["docs/**/*.md"],
  review: { points: "AGENTS.md", status: "my-review" },
  health: {
    url: "https://example.invalid/health",
    field: "commit",
    pattern: "(?P<sha>[0-9a-f]{40})",
    require: { ok: true },
  },
});
const pr = () => ({
  number: 1,
  state: "open",
  draft: false,
  merged_at: null,
  merge_commit_sha: null,
  auto_merge: null,
  labels: [{ name: "deliver" }],
  head: { sha: "head", ref: "branch", repo: { full_name: "example/app" } },
  base: { ref: "main" },
  user: { login: "owner" },
});
const run = (id = 1, head_sha = "merged", status = "completed", conclusion: string | null = "success") => ({
  id,
  head_sha,
  event: "push",
  status,
  conclusion,
  html_url: `https://example.invalid/${id}`,
});
function fixture() {
  const state: any = {
    pr: pr(),
    main: "main",
    reviewed: 0,
    merges: 0,
    statuses: [] as any[],
    writes: [] as string[],
    checks: 0,
  };
  const io: DeliveryIO = {
    async api(path, body, method) {
      if (body || method) {
        state.writes.push(path);
        if (path.startsWith("statuses/")) {
          state.statuses.push({ path, ...body });
          return {};
        }
      }
      if (path === "pulls/1") return structuredClone(state.pr);
      if (path === "git/ref/heads/main") return { object: { sha: state.main } };
      if (path.startsWith("contents/ops/delivery.json"))
        return { content: Buffer.from(JSON.stringify(config)).toString("base64") };
      if (path.startsWith("actions/workflows/check.yml")) {
        state.checks++;
        return { workflow_runs: [{ ...run(1, "head"), event: "pull_request" }] };
      }
      if (path.startsWith("actions/runs/1/jobs"))
        return { jobs: [{ name: "check", conclusion: "success", status: "completed" }] };
      if (path.startsWith("actions/workflows/ship.yml")) return { workflow_runs: [run()] };
      if (path.startsWith("issues/1/labels/")) return {};
      throw new Error(`unexpected ${path}`);
    },
    async review() {
      state.reviewed++;
      return [];
    },
    async merge() {
      state.merges++;
      state.pr.merged_at = "now";
      state.pr.merge_commit_sha = "merged";
    },
    async disableAuto() {
      state.pr.auto_merge = null;
    },
    async contains(a, b) {
      return a === b || (a === "main" && b === "head");
    },
    async releaseRequired() {
      return true;
    },
    async live() {
      return { sha: "merged", release: "merged" };
    },
    async wait() {
      throw new Error("still waiting");
    },
  };
  return { io, state };
}
test("review, full check, exact-head attestation, merge, Ship and health all finish", async () => {
  const { io, state } = fixture();
  const result = await deliver("example/app", 1, io);
  assert.equal(result.merged, "merged");
  assert.equal(state.reviewed, 1);
  assert.equal(state.merges, 1);
  assert.ok(
    state.statuses.some((s: any) => s.path === "statuses/head" && s.context === "my-review" && s.state === "success"),
  );
  assert.ok(state.statuses.some((s: any) => s.context === "delivery" && s.state === "success"));
});
test("a missing label or closed PR launches nothing; forks are refused", async () => {
  for (const change of [{ labels: [] }, { state: "closed" }]) {
    const { io, state } = fixture();
    Object.assign(state.pr, change);
    await deliver("example/app", 1, io);
    assert.equal(state.reviewed, 0);
    assert.equal(state.merges, 0);
  }
  const { io, state } = fixture();
  state.pr.head.repo.full_name = "fork/app";
  await assert.rejects(() => deliver("example/app", 1, io), /本仓库/);
  assert.equal(state.reviewed, 0);
});
test("a PR pushed during review gets no attestation and is never merged", async () => {
  const { io, state } = fixture();
  io.review = async () => {
    state.pr.head.sha = "someone-else";
    return [];
  };
  await assert.rejects(() => deliver("example/app", 1, io), /提交/);
  assert.equal(state.merges, 0);
  assert.ok(!state.statuses.some((s: any) => s.context === "my-review"));
});
function syncing(io: DeliveryIO, state: any) {
  const api = io.api;
  io.contains = async (a, b) => a === b || b === `synced-${a}` || (a === "main" && b === "head");
  io.api = async (path, body, method) => {
    if (path === "pulls/1/update-branch") {
      state.writes.push(path);
      state.pr.head.sha = `synced-${state.main}`;
      return {};
    }
    if (path.startsWith("actions/workflows/check.yml"))
      return { workflow_runs: [{ ...run(1, state.pr.head.sha), event: "pull_request" }] };
    return api(path, body, method);
  };
}
test("main advancing after review syncs in the same run and attests only the re-reviewed head", async () => {
  const { io, state } = fixture();
  syncing(io, state);
  io.review = async () => {
    if (++state.reviewed === 1) state.main = "new-main";
    return [];
  };
  const result = await deliver("example/app", 1, io);
  assert.equal(result.merged, "merged");
  assert.equal(state.reviewed, 2);
  assert.equal(state.merges, 1);
  assert.deepEqual(
    state.statuses.filter((s: any) => s.context === "my-review").map((s: any) => s.path),
    ["statuses/synced-new-main"],
  );
});
test("main that keeps advancing stops after three rounds without merging", async () => {
  const { io, state } = fixture();
  syncing(io, state);
  io.review = async () => {
    state.main = `main-${++state.reviewed}`;
    return [];
  };
  await assert.rejects(() => deliver("example/app", 1, io), /main/);
  assert.equal(state.reviewed, 3);
  assert.equal(state.merges, 0);
  assert.ok(!state.statuses.some((s: any) => s.context === "my-review"));
});
test("the review leaves out what GitHub synced beyond the main it was asked for", async () => {
  const { io, state } = fixture();
  syncing(io, state);
  const { api, contains } = io;
  // main moves on before GitHub applies the update, so the new head holds a main newer than the one read first.
  io.api = async (path, body, method) => {
    if (path === "pulls/1/update-branch") state.main = "newer";
    return api(path, body, method);
  };
  io.contains = async (a, b) => (a === "main" && b === "synced-newer") || contains(a, b);
  const bases: string[] = [];
  io.review = async (_pr, _config, base) => {
    bases.push(base);
    return [];
  };
  state.pr.head.sha = "behind";
  assert.equal((await deliver("example/app", 1, io)).merged, "merged");
  assert.deepEqual(bases, ["newer"]);
});
test("each round follows the settings of the main it reviews against", async () => {
  const { io, state } = fixture();
  syncing(io, state);
  const { api } = io;
  io.api = async (path, body, method) => {
    if (path === "contents/ops/delivery.json?ref=new-main") {
      const changed = { ...config, review: { ...config.review, status: "newer-review" } };
      return { content: Buffer.from(JSON.stringify(changed)).toString("base64") };
    }
    return api(path, body, method);
  };
  io.review = async () => {
    if (++state.reviewed === 1) state.main = "new-main";
    return [];
  };
  assert.equal((await deliver("example/app", 1, io)).merged, "merged");
  assert.deepEqual(
    state.statuses.filter((s: any) => s.context !== "delivery").map((s: any) => s.context),
    ["newer-review"],
  );
});
test("a delivery withdrawn while main moves on stops without touching the branch again", async () => {
  const { io, state } = fixture();
  syncing(io, state);
  io.review = async () => {
    state.reviewed++;
    state.main = "new-main";
    state.pr.labels = [];
    return [];
  };
  assert.equal((await deliver("example/app", 1, io)).summary, "交付标记已撤回");
  assert.equal(state.reviewed, 1);
  assert.equal(state.merges, 0);
  assert.ok(!state.writes.includes("pulls/1/update-branch"));
});
test("findings and review-only mode stop before merge", async () => {
  const first = fixture();
  first.io.review = async () => [{ title: "数据会丢", text: "先修复" }];
  const result = await deliver("example/app", 1, first.io);
  assert.equal(result.findings?.length, 1);
  assert.equal(first.state.merges, 0);
  const second = fixture();
  second.state.pr.labels.push({ name: "deliver-review" });
  assert.equal((await deliver("example/app", 1, second.io)).reviewOnly, true);
  assert.equal(second.state.merges, 0);
});
test("review-only added during checks stops before the merge attestation", async () => {
  const { io, state } = fixture();
  const api = io.api;
  io.api = async (...args) => {
    if (args[0].startsWith("actions/workflows/check.yml")) state.pr.labels.push({ name: "deliver-review" });
    return api(...args);
  };
  assert.equal((await deliver("example/app", 1, io)).reviewOnly, true);
  assert.equal(state.merges, 0);
  assert.ok(!state.statuses.some((s: any) => s.context === "my-review"));
});

test("a merge response lost after acceptance is read back, never repeated", async () => {
  const { io, state } = fixture();
  const merge = io.merge;
  io.merge = async (...args) => {
    await merge(...args);
    throw new Error("connection lost");
  };
  assert.equal((await deliver("example/app", 1, io)).merged, "merged");
  assert.equal(state.merges, 1);
});
test("label removal reads back a lost response and does not report a false delivery failure", async () => {
  const { io, state } = fixture();
  const api = io.api;
  io.api = async (...args) => {
    if (args[0] === "issues/1/labels/deliver") {
      state.pr.labels = [];
      throw new Error("Label does not exist (HTTP 404)");
    }
    return api(...args);
  };
  assert.equal((await deliver("example/app", 1, io)).merged, "merged");
  assert.equal(state.merges, 1);
  const second = fixture();
  const before = second.io.api;
  second.io.api = async (...args) => {
    if (args[0] === "issues/1/labels/deliver") throw new Error("permission denied");
    return before(...args);
  };
  await assert.rejects(() => deliver("example/app", 1, second.io), /permission denied/);
});
test("a different client merging during checks is followed without a second merge call", async () => {
  const { io, state } = fixture();
  const api = io.api;
  io.api = async (...args) => {
    if (args[0].startsWith("actions/runs/1/jobs")) {
      state.pr.merged_at = "other";
      state.pr.merge_commit_sha = "merged";
    }
    return api(...args);
  };
  assert.equal((await deliver("example/app", 1, io)).merged, "merged");
  assert.equal(state.merges, 0);
});
test("a merged PR resumes directly at Ship without reviewing or merging again", async () => {
  const { io, state } = fixture();
  state.pr.merged_at = "before";
  state.pr.merge_commit_sha = "merged";
  state.pr.state = "closed";
  assert.equal((await deliver("example/app", 1, io)).merged, "merged");
  assert.equal(state.reviewed, 0);
  assert.equal(state.merges, 0);
});
test("only the latest exact-head full workflow and successful required job count", async () => {
  for (const [workflow, job, want] of [
    [run(1, "head"), { name: "draft", conclusion: "success" }, "waiting"],
    [run(1, "old"), { name: "check", conclusion: "success" }, "waiting"],
    [run(1, "head"), { name: "check", conclusion: "skipped" }, "waiting"],
    [run(1, "head", "completed", "failure"), { name: "check", conclusion: "skipped" }, "failed"],
    [run(1, "head"), { name: "check", conclusion: "success", status: "completed" }, "passed"],
  ] as const) {
    const { io } = fixture();
    io.api = async (p) =>
      p.includes("/jobs") ? { jobs: [job] } : { workflow_runs: [{ ...workflow, event: "pull_request" }] };
    assert.equal(await fullCheck("head", config, io), want);
  }
});
test("a cancelled draft-only workflow does not fail the new ready check", async () => {
  const { io } = fixture();
  io.api = async (p) =>
    p.includes("/jobs")
      ? { jobs: [{ name: "draft", conclusion: "cancelled" }] }
      : { workflow_runs: [{ ...run(1, "head", "completed", "cancelled"), event: "pull_request" }] };
  assert.equal(await fullCheck("head", config, io), "waiting");
});
test("failed full checks never attest or merge and existing auto-merge is confirmed off", async () => {
  const { io, state } = fixture();
  state.pr.auto_merge = {};
  const api = io.api;
  io.api = async (...args) =>
    args[0].startsWith("actions/workflows/check")
      ? { workflow_runs: [{ ...run(1, "head", "completed", "failure"), event: "pull_request" }] }
      : api(...args);
  await assert.rejects(() => deliver("example/app", 1, io), /检查/);
  assert.equal(state.pr.auto_merge, null);
  assert.equal(state.merges, 0);
  assert.ok(!state.statuses.some((s: any) => s.context === "my-review"));
});
test("auto-merge cancellation reads back dropped requests and refuses unknown state", async () => {
  const { io, state } = fixture();
  state.pr.auto_merge = {};
  io.disableAuto = async () => {
    state.pr.auto_merge = null;
    throw new Error("lost");
  };
  await disableAuto(1, io);
  state.pr.auto_merge = {};
  io.disableAuto = async () => {};
  io.wait = async () => {};
  await assert.rejects(() => disableAuto(1, io), /自动合并/);
});
test("auto-merge read-back failure is retried but never treated as disabled", async () => {
  const { io } = fixture();
  let reads = 0;
  io.wait = async () => {};
  io.api = async () => {
    if (++reads === 1) throw new Error("HTTP 502");
    return { auto_merge: null };
  };
  await disableAuto(1, io);
  assert.equal(reads, 2);
  reads = 0;
  io.api = async () => {
    reads++;
    throw new Error("HTTP 502");
  };
  await assert.rejects(() => disableAuto(1, io), /无法确认自动合并/);
  assert.equal(reads, 3);
});
test("live health cannot hide incomplete or failed Ship", async () => {
  for (const [status, conclusion] of [
    ["in_progress", null],
    ["completed", "failure"],
    ["completed", "cancelled"],
  ] as const) {
    const { io } = fixture();
    io.api = async () => ({ workflow_runs: [run(1, "merged", status, conclusion)] });
    await assert.rejects(() => waitLive("merged", config, io));
  }
});
test("a completed delivery ignores later queued/failed releases; a successor needs to be live", async () => {
  for (const status of ["queued", "completed"]) {
    const { io } = fixture();
    io.contains = async (a, b) => a === b || (a === "merged" && b === "later");
    io.api = async () => ({ workflow_runs: [run(), run(2, "later", status, "failure")] });
    await waitLive("merged", config, io);
  }
  const { io } = fixture();
  io.contains = async (a, b) => a === b || (a === "merged" && b === "later");
  io.api = async () => ({ workflow_runs: [run(1, "merged", "completed", "cancelled"), run(2, "later")] });
  await assert.rejects(() => waitLive("merged", config, io), /waiting/);
  io.live = async () => ({ sha: "later", release: "later" });
  await waitLive("merged", config, io);
});
