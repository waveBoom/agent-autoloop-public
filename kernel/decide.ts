// Everything that can change the hub is decided here: given the view and one input, the facts to record and the answer
// to give. Time and secrets come in as arguments, so the same input on the same view always decides the same.
import { credential, digest, type Environment } from "./credentials.ts";
import { latestBefore, nextRun, parseCron } from "./cron.ts";
import { deadlines, MINUTE, offlineCard, OFFLINE_AFTER, RUN_LEASE, SEEN_EVERY, WORKER_FRESH } from "./due.ts";
import { AuthError, Conflict, InputError, NotFound } from "./errors.ts";
import { manualStatusLabels } from "./issue-progress.ts";
import { localRecordsOf } from "./local-records.ts";
import { requiresOriginalSession } from "../protocol/job.ts";
import { iso, rows, type Change, type Fact, type Row, type Table, type View } from "./evolve.ts";
import {
  agentsOf,
  cardView,
  configuration,
  eventsOf,
  isCurrentPlan,
  jobOf,
  openInScope,
  sourceOf,
  waitingOn,
  workerOf,
  workers,
} from "./query.ts";
import {
  cronOf,
  eventRule,
  PLAN_KEY,
  PLAN_OPTIONS,
  SCHEDULE,
  typeMatches,
  worktreesOf,
  type Rule,
  type Rules,
} from "./rules.ts";
import {
  addUsage,
  ANSWER_BY,
  ANSWER_REF,
  ANSWER_TEXT,
  DELIVERY_REF,
  parseEvent,
  parseResult,
  type Later,
  type Rejected,
  type Result,
} from "../protocol/validate.ts";

export type Input = { type: string; args: any[] };

/** Minutes after the first try that a card is sent to a channel again. */
const RESEND_AT = [0, 1, 3, 7, 15, 25, 35, 45, 55];
/** The last resend and the minute it holds the card: after this a channel has given up. */
const RESEND_WINDOW = 57 * MINUTE;
/** How long a chain of events causing events can get before it stops being dispatched. */
const MAX_HOPS = 8;
/** Failures in a row after which a run stops being retried: each try spends the owner's real tokens. */
const MAX_ATTEMPTS = 10;
const NOT_TRYING = { tries: 0, first_try_at: null, not_before: null };
const NOT_DELIVERED: Row = { version: 0, ref: null, ...NOT_TRYING, error: null, given_up: 0 };

const nulls = (...names: string[]) => Object.fromEntries(names.map((name) => [name, null]));
const CARD_BASICS = { text: "", options: "[]", recommend: null, about: "", state: "open", fyi: 0, quiet: 0 };
const DEFAULTS: Partial<Record<Table, Row>> = {
  runs: {
    attempts: 0,
    ...nulls("claim", "issued", "last_issued", "last_result", "last_answer", "cancel_at", "resume", "session", "link"),
    ...nulls("claimed_at", "seen_at", "finished_at", "summary", "error", "usage"),
  },
  cards: {
    ...CARD_BASICS,
    ...nulls("choice", "answer", "by", "result", "rule"),
    lane: "",
    ...nulls("grp", "source", "agent", "session", "run_id", "answer_event"),
    version: 1,
    ...nulls("decided_at", "closed_at"),
  },
  deliveries: NOT_DELIVERED,
};

type Given = { type: string; seq: number; now: number; at: string; env: Environment; rules: Rules };
/** One input being decided: what holds throughout, and the view with its changes so far. */
type Draft = Given & { view: View; changes: Change[] };

export function decide(view: View, input: Input, now: number, env: Environment): { facts: Fact[]; value: any } {
  const { type, args } = input;
  if (!Object.hasOwn(HANDLERS, type)) throw new InputError(`不认识的输入：${type}`);
  const rules = configuration(view);
  const draft: Draft = { view: view.fork(), seq: view.seq + 1, type, now, at: iso(now), env, rules, changes: [] };
  const value = HANDLERS[type](draft, ...args);
  // With nothing changed nothing new can come due, and what only the clock changes has a deadline of its own to bring a tick.
  if (!draft.changes.length && type !== "tick") return { facts: [], value };
  const due = deadlines(draft.view, now);
  for (const [key, row] of Object.entries(due)) {
    if (JSON.stringify(draft.view.get("due", key)) !== JSON.stringify(row)) put(draft, "due", key, row);
  }
  for (const { kind, key: name } of rows(draft.view, "due")) {
    const key = `${kind}:${name}`;
    if (!due[key]) set(draft, "due", key, null);
  }
  return { facts: draft.changes.length ? [factOf(draft, draft.changes)] : [], value };
}

function factOf({ seq, now, type }: Draft, changes: Change[]): Fact {
  return { version: 1, seq, at: now, type, changes };
}

function set(draft: Draft, table: Table, key: string | number, row: Row | null) {
  const change = { table, key: String(key), row };
  draft.changes.push(change);
  draft.view.set(table, String(key), row);
  return row!;
}

const put = (draft: Draft, table: Table, key: string | number, fields: Row) =>
  set(draft, table, key, { ...DEFAULTS[table], ...draft.view.get(table, key), ...fields });

function add(draft: Draft, table: Table, fields: Row) {
  const id = (draft.view.next[table] ?? 0) + 1;
  return put(draft, table, id, { ...fields, id });
}

const ruleNamed = (draft: Draft, name: string) => draft.rules.rules.find((rule) => rule.name === name);
function assignQueued(draft: Draft, run: Row) {
  const config = draft.view.get("config", "rules")!;
  const rule = (config.value as Rules).rules.find((rule) => rule.name === run.rule);
  if (!rule) return;
  const session = rule.to === run.agent ? {} : nulls("session", "resume");
  put(draft, "runs", run.id, { agent: rule.to, rules_version: config.version, ...session });
}
const threadOf = (run: Row) => ({ rule: run.rule, lane: run.lane, grp: run.grp });
const hopsOf = (draft: Draft, run: Row) => Math.max(0, ...eventsOf(draft.view, run.id).map((event) => event.hops ?? 0));

function closeCard(draft: Draft, card: Row, result: string, by: string | null = null, note: string | null = null) {
  const closed = { state: "closed", closed_at: draft.at, version: card.version + 1 };
  // A note says how a notice was handled, for looking back at later.
  put(draft, "cards", card.id, { ...closed, result, by: by ?? card.by, ...(note ? { answer: note } : {}) });
}

function closeOpen(draft: Draft, matches: (key: string) => boolean, result: string) {
  const open = rows(draft.view, "cards", { state: "open" }).filter((card) => matches(card.key));
  for (const card of open) closeCard(draft, card, result);
}

const closeOffline = (draft: Draft, worker: string) =>
  closeOpen(draft, (key) => key.startsWith(`worker:${worker}:offline:`), "连上了");

/** Whether a new stamp would tell nothing this one doesn't. One in the future means a clock was set back: it gets redone. */
function justSeen({ now }: Draft, row?: Row) {
  const age = now - Date.parse(row?.seen_at);
  return age >= 0 && age < SEEN_EVERY;
}

function createCard(draft: Draft, spec: Row) {
  const cards = rows(draft.view, "cards", { key: spec.key, ...(!spec.once && { state: "open" }) }, 1, true);
  const existing = cards.findLast((card) => card.key === spec.key && (spec.once || card.state === "open"));
  if (existing) return { card: existing.id, duplicate: true };
  const { once, run, options, fyi, quiet, ...fields } = spec;
  const stored = {
    run_id: run ?? null,
    options: JSON.stringify(options ?? []),
    fyi: fyi ? 1 : 0,
    quiet: quiet ? 1 : 0,
  };
  const card = add(draft, "cards", { ...fields, ...stored, state: fyi ? "closed" : "open", created_at: draft.at });
  return { card: card.id, duplicate: false };
}

const notify = (draft: Draft, key: string, title: string, text: string, extra: Row = {}) =>
  createCard(draft, { key, kind: "notice", title, text, ...extra });

/** A queued run of this rule and subject takes the event, so what comes in while it waits is handled together. */
const issueKey = (rule: string, subject: string) => `issue:${JSON.stringify([rule, subject])}`;
const businessStages: Record<string, string> = {
  ...manualStatusLabels,
  deployed: "准备提测",
  test_approved: "准备提测",
};
function manualStatusHistory(current?: Row) {
  const history = current?.manualStatusHistory ?? [];
  const manual = current?.manualStatus;
  const last = history.at(-1);
  return manual && (last?.at !== manual.at || last?.status !== manual.status) ? [...history, manual] : history;
}

function businessStage(draft: Draft, rule: string, subject: string, stage: string, detail: Row = {}) {
  const key = issueKey(rule, subject);
  const current = draft.view.get("config", key);
  if (!subject?.startsWith("loop:") || current?.closed) return;
  const label = detail.stageLabel ?? businessStages[stage];
  const history =
    current && current.stageLabel === label
      ? current.history
      : [...(current?.history ?? []).slice(-29), { label, at: draft.at }];
  put(draft, "config", key, {
    rule,
    subject,
    stage,
    stageLabel: label,
    stageAt: draft.at,
    manualStatus: null,
    ...(current?.manualStatus && { manualStatusHistory: manualStatusHistory(current) }),
    history,
    deployment: null,
    reviewCard: null,
    evidence: null,
    ...detail,
  });
}
const issueClosed = (draft: Draft, rule: Rule, subject: string) =>
  subject && draft.view.get("config", issueKey(rule.name, subject))?.closed === true;

function enqueue(draft: Draft, rule: Rule, event: number, subject: string, resume?: string | null) {
  const lane = rule.parallel ? subject : "";
  const rulesVersion = draft.view.get("config", "rules")!.version;
  const stamps = { not_before: draft.at, created_at: draft.at, rules_version: rulesVersion };
  const isSameQueued = (run: Row) => run.rule === rule.name && run.lane === lane && run.state === "queued";
  const run =
    rows(draft.view, "runs", { rule: rule.name, lane, state: "queued" }).find(isSameQueued) ??
    add(draft, "runs", { rule: rule.name, agent: rule.to, grp: rule.group, lane, state: "queued", ...stamps });
  put(draft, "run_events", `${run.id}:${event}`, { run_id: run.id, event_id: event });
  if (resume && !run.pinned_session) put(draft, "runs", run.id, { resume });
  return run.id;
}

/** Keeps an event under a key of its own: one the hub makes up mustn't collide with one a source sent. */
function recordEvent(draft: Draft, source: string, event: Row, routed: string[], matched?: string[]): number {
  let key = event.id;
  for (let suffix = 1; rows(draft.view, "events", { source, key }).length; suffix++) {
    key = `${event.id}:${suffix}`;
  }
  return add(draft, "events", {
    source,
    key,
    type: event.type,
    subject: event.subject ?? "",
    summary: event.summary ?? "",
    detail: event.detail ?? "",
    link: event.link ?? "",
    hops: event.hops ?? 0,
    routed: JSON.stringify(routed),
    ...(matched && { matched }),
    received_at: draft.at,
  }).id;
}

function ingest(draft: Draft, source: string, given: unknown) {
  const event = parseEvent(given);
  const existing = rows(draft.view, "events", { source, key: event.id })[0];
  if (existing) return { event: existing.id, duplicate: true, routed: existing.matched ?? JSON.parse(existing.routed) };
  const tooDeep = event.hops > MAX_HOPS;
  const takes = (rule: Rule) =>
    eventRule(rule) && rule.when.source === source && typeMatches(rule.when.types, event.type);
  const matched = tooDeep ? [] : draft.rules.rules.filter(takes);
  const routed = matched.map((rule) => rule.name);
  const dispatch = matched.filter((rule) => !issueClosed(draft, rule, event.subject));
  const id = recordEvent(
    draft,
    source,
    event,
    dispatch.map((rule) => rule.name),
    dispatch.length !== matched.length ? routed : undefined,
  );
  if (tooDeep) {
    const words = `同一条处理链已超过 ${MAX_HOPS} 层，后续事件已记录，没有继续派发。`;
    notify(draft, `hops:${source}:${event.id}`, "事件循环已停止", words, { once: true });
  }
  for (const rule of dispatch) {
    const key = issueKey(rule.name, event.subject);
    if (event.type.endsWith(".comment")) {
      const current = draft.view.get("config", key);
      if (current?.reviewCard)
        closeOpen(
          draft,
          (cardKey) => cardKey === `test-review:${key}:${current.deployment?.version}`,
          "收到新评论，提测卡已过期",
        );
      if (event.subject.startsWith("loop:")) businessStage(draft, rule.name, event.subject, "accepted");
      else if (current?.stage === "testing") put(draft, "config", key, { stage: null, stageAt: null });
    } else if (event.type.endsWith(".created") && !draft.view.get("config", key)?.stage) {
      businessStage(draft, rule.name, event.subject, "accepted");
    }
    enqueue(draft, rule, id, event.subject);
  }
  return { event: id, duplicate: false, routed };
}

function heldRun(draft: Draft, id: number, token: string, states: string[]) {
  const run = draft.view.get("runs", id);
  const issued = run && states.includes(run.state) && run.issued !== null;
  if (!issued || credential(draft.env, "run", id, run.issued) !== token) throw new AuthError("这件活不归这个令牌");
  return run;
}

function cardFromReceipt(draft: Draft, run: Row, kind: string, card: Row, planApproval = false) {
  const name = card.key ?? digest(`${card.title}\n${card.text}`).slice(0, 32);
  const session = draft.view.get("runs", run.id)!.session;
  const quiet = kind === "notice" && ruleNamed(draft, run.rule)?.tell === "never";
  const origin = { source: sourceOf(draft.view, run.id), agent: run.agent, session, run: run.id };
  const key = planApproval ? `plan:${run.id}` : `thread:${run.rule}:${run.lane}:${name}`;
  const sourceEvents =
    origin.source && run.lane
      ? rows(draft.view, "events", { source: origin.source, subject: run.lane }).filter((event) =>
          JSON.parse(event.routed).includes(run.rule),
        )
      : [];
  const sourceLink = sourceEvents.findLast((event) => event.link)?.link;
  const sourceTitle = sourceEvents.find((event) => event.summary && event.type.endsWith(".created"))?.summary;
  const result = createCard(draft, {
    ...card,
    hops: hopsOf(draft, run),
    key,
    kind,
    quiet,
    ...threadOf(run),
    ...origin,
    ...(planApproval && { plan_approval: true }),
    ...(sourceLink && { source_link: sourceLink }),
    ...(sourceTitle && { source_title: sourceTitle }),
  });
  const saved = draft.view.get("cards", result.card);
  if (planApproval && saved && isCurrentPlan(draft.view, saved, run.agent, run.rules_version))
    businessStage(draft, run.rule, run.lane, "plan_review");
}

/** Notices what has gone quiet: a worker that stopped coming, a run its worker stopped mentioning. */
function sweep(draft: Draft) {
  const { now } = draft;
  for (const worker of workers(draft.view)) {
    const seen = draft.view.get("seen", `worker:${worker}`);
    const lastSeen = seen ? Date.parse(seen.seen_at) : undefined;
    if (lastSeen !== undefined && now - lastSeen <= WORKER_FRESH) {
      closeOffline(draft, worker);
      const inDoubt = (run: Row) =>
        run.state === "claimed" && workerOf(draft.view, run) === worker && Date.parse(run.seen_at) < now - RUN_LEASE;
      for (const run of rows(draft.view, "runs", { state: "claimed" }).filter(inDoubt)) {
        put(draft, "runs", run.id, { state: "unknown" });
        const agent = configuration(draft.view, run.rules_version).agents[run.agent].name;
        const words = `交给 ${agent} 后超过 5 分钟没有回音，不确定做没做完；后续新任务照常处理。`;
        notify(draft, `run:${run.id}:unknown`, run.rule, words, threadOf(run));
      }
    }
    const waiting = waitingOn(draft.view, worker, now);
    if (!waiting.length) continue;
    const since = now - (lastSeen ?? Date.parse(waiting[0].created_at));
    const { key, told } = offlineCard(draft.view, worker, waiting);
    if (since <= OFFLINE_AFTER || told) continue;
    const minutes = Math.floor(since / MINUTE);
    const neverSeen = lastSeen === undefined;
    const situation = neverSeen
      ? `${worker} 一直没连上中台，有 ${waiting.length} 件任务等了 ${minutes} 分钟没人接`
      : `${worker} 已经 ${minutes} 分钟没连上中台，有 ${waiting.length} 件任务在排队或在跑`;
    const check = neverSeen ? "有没有开机联网" : "是不是关机、休眠或断网了";
    notify(draft, key, "接单程序没连上", `${situation}（请看一眼那台电脑${check}）。`);
  }
}

function followupSession(draft: Draft, run: Row): string | undefined {
  const rule = ruleNamed(draft, run.rule);
  if (!rule?.resumeOn || !eventRule(rule) || !run.lane || run.session || run.resume) return;
  const events = eventsOf(draft.view, run.id);
  if (
    !events.length ||
    !events.every(
      (event) =>
        event.source === rule.when.source &&
        typeMatches(rule.resumeOn!, event.type) &&
        JSON.parse(event.routed).includes(rule.name),
    )
  )
    return;
  const [previous] = rows(
    draft.view,
    "runs",
    {
      rule: run.rule,
      lane: run.lane,
      state: ["done", "nothing", "cancelled", "unknown"],
    },
    1,
    true,
  );
  if (!previous?.session || !["done", "nothing"].includes(previous.state) || previous.agent !== rule.to) return;
  const old = configuration(draft.view, previous.rules_version);
  const oldRule = old?.rules.find((item) => item.name === rule.name);
  const oldAgent = old?.agents[previous.agent];
  const agent = draft.rules.agents[rule.to];
  if (
    !oldRule ||
    !eventRule(oldRule) ||
    oldRule.when.source !== rule.when.source ||
    oldRule.cwd !== rule.cwd ||
    JSON.stringify(oldRule.repositories) !== JSON.stringify(rule.repositories) ||
    JSON.stringify(worktreesOf(oldRule, run.lane)) !== JSON.stringify(worktreesOf(rule, run.lane)) ||
    oldAgent?.worker !== agent.worker ||
    oldAgent.use !== agent.use ||
    JSON.stringify(oldAgent.command) !== JSON.stringify(agent.command)
  )
    return;
  return previous.session;
}

function claimNext(draft: Draft, worker: string, claim: string) {
  const agents = agentsOf(draft.view, worker);
  const runs = rows(draft.view, "runs", { state: ["queued", "claimed"] });
  const claimed = runs.filter((run) => run.state === "claimed");
  const groupLimit = (group: string) => draft.rules.rules.find((rule) => rule.group === group)?.parallel ?? 1;
  const claimable = (run: Row) => {
    const disposition = draft.view.get("config", issueKey(run.rule, run.lane));
    return (
      run.state === "queued" &&
      agents.includes(ruleNamed(draft, run.rule)?.to ?? "") &&
      Date.parse(run.not_before) <= draft.now &&
      ruleNamed(draft, run.rule) &&
      !disposition?.appHandoff &&
      !disposition?.localDebug &&
      !rows(draft.view, "runs", { rule: run.rule, lane: run.lane, state: "queued", session_blocked: 1 }, 1).length &&
      !claimed.some((other) => other.grp === run.grp && other.lane === run.lane) &&
      claimed.filter((other) => other.grp === run.grp).length < groupLimit(run.grp)
    );
  };
  // The same claim again means the answer got lost: it gets back the run it already has.
  const held = claimed.find((run) => run.claim === claim && workerOf(draft.view, run) === worker);
  const run = held ?? runs.find(claimable);
  if (!run) return null;
  if (!held) {
    assignQueued(draft, run);
    const resume = followupSession(draft, draft.view.get("runs", run.id)!);
    if (resume) put(draft, "runs", run.id, { resume });
  }
  const since = held ? { claimed_at: run.claimed_at, link: run.link } : { claimed_at: draft.at, link: null };
  const rules_version = held ? run.rules_version : draft.view.get("config", "rules")!.version;
  const claiming = { state: "claimed", claim, issued: draft.seq, seen_at: draft.at, rules_version, ...since };
  put(draft, "runs", run.id, { ...claiming, ...nulls("last_issued", "last_result", "last_answer") });
  return jobOf(draft.view, draft.view.get("runs", run.id)!, draft.env);
}

/** Ends a run nothing will pick up again, and says so. */
function stopRun(draft: Draft, run: Row, why: string, summary: string, words: string) {
  put(draft, "runs", run.id, { state: "cancelled", finished_at: draft.at, summary });
  notify(draft, `run:${run.id}:${why}`, run.rule, words, threadOf(run));
}

const ruleGone = (run: Row): [string, string] => [
  `规则「${run.rule}」不在了，不再派发`,
  `规则「${run.rule}」不在了（删掉或改名了），排着的这一轮不再派发。还要做的话重新触发这件事。`,
];

/** A run that didn't get through waits to try again, and takes along whatever came in for the same thing meanwhile. */
function retryLater(draft: Draft, run: Row, result: Result) {
  const { id } = run;
  const attempts = run.attempts + 1;
  const notBefore = draft.now + Math.min(5 * MINUTE * 2 ** (attempts - 1), 60 * MINUTE);
  const error = (result.error ?? "").trim().replace(/[。.]+$/, "") || "没说原因";
  const unclaimed = nulls("claim", "claimed_at", "seen_at", "cancel_at");
  const rejected: Rejected[] = [];
  for (const what of ["ask", "resolve", "later", "events"] as const) {
    for (const _ of result[what] ?? []) rejected.push({ what, reason: "没跑成的一轮只能发通知" });
  }
  for (const notice of result.notice ?? []) cardFromReceipt(draft, run, "notice", notice);
  const failure = { attempts, error, ...unclaimed };
  if (!ruleNamed(draft, run.rule)) {
    put(draft, "runs", id, failure);
    stopRun(draft, run, "rule-gone", ...ruleGone(run));
    return rejected;
  }
  if (attempts >= MAX_ATTEMPTS) {
    // Runs queued for this thread stay apart: they came in since, and get their own count and their own go.
    const summary = `连续 ${MAX_ATTEMPTS} 次没跑成，不再自动重试`;
    closeOpen(draft, (key) => key === `run:${id}:failing`, summary);
    const words = `连续 ${MAX_ATTEMPTS} 次自动处理没跑完（卡在：${error}），不再自动重试。解决后重新触发这件事，它会从头开始。`;
    put(draft, "runs", id, failure);
    stopRun(draft, run, "stopped", summary, words);
    return rejected;
  }
  put(draft, "runs", id, { state: "queued", not_before: iso(notBefore), ...failure });
  const sameThread = (other: Row) => other.id !== id && other.rule === run.rule && other.lane === run.lane;
  for (const other of rows(draft.view, "runs", { rule: run.rule, lane: run.lane, state: "queued" }).filter(
    sameThread,
  )) {
    for (const link of rows(draft.view, "run_events", { run_id: other.id })) {
      put(draft, "run_events", `${id}:${link.event_id}`, { run_id: id, event_id: link.event_id });
      set(draft, "run_events", `${other.id}:${link.event_id}`, null);
    }
    set(draft, "runs", other.id, null);
    if (other.resume) put(draft, "runs", id, { resume: other.resume });
  }
  if (!result.notice?.length && attempts === 3) {
    const clock = { timeZone: draft.rules.timezone, hour: "2-digit", minute: "2-digit", hourCycle: "h23" } as const;
    const time = new Intl.DateTimeFormat("zh-CN", clock).format(notBefore);
    const words = `连续 3 次自动处理没跑完（卡在：${error}），${time} 会自动再试。`;
    notify(draft, `run:${id}:failing`, run.rule, words, threadOf(run));
  }
  assignQueued(draft, draft.view.get("runs", id)!);
  return rejected;
}

function scheduleReview(draft: Draft, run: Row, later: Later) {
  const { rule, lane } = run;
  const existing = rows(draft.view, "timers", { rule, lane, key: later.key, event_id: null }).find(
    (timer) => timer.rule === rule && timer.lane === lane && timer.key === later.key && timer.event_id === null,
  );
  if (later.cancel) {
    if (existing) set(draft, "timers", existing.id, null);
    return;
  }
  const session = draft.view.get("runs", run.id)!.session;
  const fields = { at: iso(Date.parse(later.at!)), about: later.about, session, hops: hopsOf(draft, run) };
  if (existing) return void put(draft, "timers", existing.id, fields);
  const source = sourceOf(draft.view, run.id) ?? SCHEDULE;
  add(draft, "timers", { ...fields, rule, lane, key: later.key, source, event_id: null, created_at: draft.at });
}

/** A receipt takes effect here, all of it in the one fact. */
function applyReceipt(draft: Draft, run: Row, result: Result) {
  const { id } = run;
  const rule = ruleNamed(draft, run.rule);
  const summary = result.summary ?? "";
  const rejected: Rejected[] = [];
  const verifiedBranches = result.outcome === "done" && result.testBranchesPushed;
  if (verifiedBranches && jobOf(draft.view, run, draft.env).context.approvedPlan) {
    businessStage(draft, run.rule, run.lane, "test_branch_pushed", {
      stageLabel: `测试分支已推送: ${[...new Set(verifiedBranches)].sort().join("、")}`,
    });
  }
  put(draft, "runs", id, { state: result.outcome, finished_at: draft.at, summary, error: null, cancel_at: null });
  closeOpen(draft, (key) => key === `run:${id}:failing`, "后来跑成了");
  closeOpen(draft, (key) => key === `run:${id}:unknown`, "结果回来了");
  const inputs = eventsOf(draft.view, id);
  const eventIds = inputs.map((event) => event.id);
  const sessionContinuation = inputs.some(({ type }) => requiresOriginalSession(type));
  const isAnswered = (card: Row) => card.state === "decided" && eventIds.includes(card.answer_event);
  for (const card of rows(draft.view, "cards", { answer_event: eventIds, state: "decided" }).filter(isAnswered)) {
    put(draft, "cards", card.id, { state: "done", result: summary, closed_at: draft.at, version: card.version + 1 });
  }
  for (const item of result.resolve ?? []) {
    const card = openInScope(draft.view, run).find((card) => card.id === item.card);
    if (!card) rejected.push({ card: item.card, reason: "不在本轮核对范围" });
    else if (sessionContinuation && (card.plan_approval || card.key.startsWith("test-review:")))
      rejected.push({ card: item.card, reason: "审批卡仍需负责人处理" });
    else closeCard(draft, card, item.reason.trim(), `第 ${id} 轮`);
  }
  const runRule = configuration(draft.view, run.rules_version).rules.find((item) => item.name === run.rule);
  for (const ask of result.ask ?? []) {
    const planApproval = Boolean(runRule?.planApproval && ask.key === PLAN_KEY);
    if (planApproval && (!run.lane || JSON.stringify(ask.options) !== JSON.stringify(PLAN_OPTIONS))) {
      rejected.push({ what: "ask", reason: "开发方案需要有效的 subject 和固定的确认选项" });
      continue;
    }
    if (planApproval && runRule?.prepareWorktrees) {
      if (
        !ask.repositories?.length ||
        !ask.repositories.every((alias) => Object.hasOwn(runRule.repositories ?? {}, alias))
      ) {
        rejected.push({ what: "ask", reason: "开发方案必须列出本轮要准备的已登记仓库" });
        continue;
      }
      const text = `确认后准备这些仓库的任务 worktree：${ask.repositories.join("、")}。有 origin 时会拉取其主分支。\n\n${ask.text}`;
      if ([...text].length > 4000) {
        rejected.push({ what: "ask", reason: "方案和仓库范围合计不能超过 4000 字" });
        continue;
      }
      cardFromReceipt(draft, run, "ask", { ...ask, text }, true);
      continue;
    }
    cardFromReceipt(draft, run, "ask", ask, planApproval);
  }
  for (const notice of result.notice ?? []) cardFromReceipt(draft, run, "notice", notice);
  if (rule?.tell === "always" && result.outcome === "done") {
    const once = { fyi: true, once: true, ...threadOf(run), source: sourceOf(draft.view, id), run: id };
    notify(draft, `run:${id}:done`, run.rule, summary, once);
  }
  for (const later of result.later ?? []) scheduleReview(draft, run, later);
  for (const event of result.events ?? []) {
    if (rule?.emits && typeMatches(rule.emits.types, event.type)) {
      ingest(draft, rule.emits.source, { ...event, hops: hopsOf(draft, run) + 1 });
    } else rejected.push({ what: "events", reason: `规则「${run.rule}」没有写可以发 ${event.type}` });
  }
  return rejected;
}

function finish(draft: Draft, id: number, token: string, given: unknown) {
  const hash = digest(JSON.stringify(given ?? null));
  const prior = draft.view.get("runs", id);
  // The same execution handing in again means the answer got lost: it gets the same answer, and nothing happens twice.
  if (prior && prior.last_issued !== null && credential(draft.env, "run", id, prior.last_issued) === token) {
    if (prior.last_result !== hash) throw new Conflict("这一次执行已经交过不一样的结果");
    return { rejected: JSON.parse(prior.last_answer ?? "[]"), duplicate: true };
  }
  const run = heldRun(draft, id, token, ["claimed", "unknown"]);
  const result = parseResult(given);
  const session = result.session ?? run.session;
  const usage = result.usage
    ? JSON.stringify(addUsage(run.usage ? JSON.parse(run.usage) : undefined, result.usage))
    : run.usage;
  put(draft, "runs", id, { last_issued: run.issued, last_result: hash, issued: null, session, usage });
  let rejected: Rejected[] = [];
  if (result.sessionBlocked) {
    if (!eventsOf(draft.view, id).some(({ type }) => requiresOriginalSession(type)))
      throw new InputError("只有要求续接原会话的轮次可以报告阻塞");
    put(draft, "runs", id, {
      state: "queued",
      session_blocked: true,
      not_before: draft.at,
      error: result.error || "原会话暂不可用",
      ...nulls("claim", "claimed_at", "seen_at", "cancel_at"),
    });
  } else if (result.outcome === "failed") rejected = retryLater(draft, run, result);
  else if (result.outcome === "cancelled") {
    put(draft, "runs", id, {
      state: "cancelled",
      finished_at: draft.at,
      summary: result.summary ?? "",
      cancel_at: null,
    });
  } else rejected = applyReceipt(draft, run, result);
  put(draft, "runs", id, { last_answer: JSON.stringify(rejected) });
  return { rejected };
}

function answer(draft: Draft, id: number, given: Row) {
  const card = draft.view.get("cards", id);
  if (!card) throw new NotFound("没有这张卡片");
  const channel = given.channel === undefined ? undefined : draft.rules.channels[given.channel];
  if (given.channel !== undefined) {
    const allowed = channel?.answerers;
    if (allowed && !allowed.includes(given.by ?? "")) throw new AuthError("这个人不能回答这张卡片");
    const delivery = draft.view.get("deliveries", `${id}:${given.channel}`);
    if (!delivery?.ref || delivery.ref !== given.ref) throw new AuthError("不是发出去的那条消息");
  }
  if (card.state !== "open") return { changed: false, state: card.state };
  if (card.plan_approval) {
    const owner = given.channel === undefined && given.by === "本人";
    const allowedChannel = channel?.planApprovals === true && channel.answerers?.includes(given.by ?? "");
    if (!owner && !allowedChannel) throw new AuthError("请用本人 CLI 或已授权的通道回答开发方案卡片");
  }
  if (given.by !== undefined && (typeof given.by !== "string" || [...given.by].length > ANSWER_BY)) {
    throw new InputError(`回答人最多 ${ANSWER_BY} 字`);
  }
  if (given.ref !== undefined && (typeof given.ref !== "string" || [...given.ref].length > ANSWER_REF)) {
    throw new InputError(`消息编号最多 ${ANSWER_REF} 字`);
  }
  if (card.kind === "notice") {
    if (given.text !== undefined && typeof given.text !== "string") throw new InputError("处理说明要是文字");
    const note = given.text?.trim() || null;
    if (note !== null && [...note].length > ANSWER_TEXT) throw new InputError(`处理说明最多 ${ANSWER_TEXT} 字`);
    closeCard(draft, card, "已处理", given.by ?? null, note);
    return { changed: true, state: "closed" };
  }
  if (given.text !== undefined && typeof given.text !== "string") throw new InputError("回答要是文字");
  const text = given.text?.trim() || null;
  if (text !== null && [...text].length > ANSWER_TEXT) throw new InputError(`回答最多 ${ANSWER_TEXT} 字`);
  const optionCount = JSON.parse(card.options).length;
  const inRange = Number.isInteger(given.choice) && given.choice >= 0 && given.choice < optionCount;
  if (given.choice === undefined ? !text : !inRange) throw new InputError("没有这个选项");
  const rule = card.rule ? ruleNamed(draft, card.rule) : undefined;
  const { lane: subject, title: summary, hops = 0 } = card;
  if (card.key.startsWith("test-review:")) {
    if (
      !(given.channel === undefined && given.by === "本人") &&
      !(channel?.planApprovals === true && channel.answerers?.includes(given.by ?? ""))
    )
      throw new AuthError("请由已授权的负责人处理提测确认");
    const current = draft.view.get("config", issueKey(card.rule, subject));
    if (current?.stage !== "deployed" || current.reviewCard !== id) throw new Conflict("该提测卡已过期");
    if (given.choice === 0) {
      closeCard(draft, card, "已确认通知需求方", given.by, text);
      put(draft, "cards", id, { choice: 0, decided_at: draft.at });
      businessStage(draft, card.rule, subject, "test_approved", {
        deployment: current.deployment,
        evidence: current.evidence,
      });
      const notifyIssue = /^[A-Z][A-Z0-9_-]*-\d+(?=\s|$)/.exec(card.source_title ?? "")?.[0];
      return {
        changed: true,
        state: "closed",
        ...(notifyIssue && { notifyIssue, notifyStageAt: draft.at, notifyRule: card.rule }),
      };
    }
    if (given.choice !== 1 || !text || !rule) throw new InputError("退回时请填写修改意见");
    businessStage(draft, card.rule, subject, "accepted", { evidence: text });
  }
  if (card.plan_approval && given.choice === 0) {
    const version = draft.view.get("config", "rules")!.version;
    if (!rule?.planApproval || !isCurrentPlan(draft.view, card, rule.to, version))
      throw new Conflict("方案已过期，请查看最新方案");
  }
  const event = { id: `card:${id}`, type: "card.answered", subject, summary, hops };
  const eventId = recordEvent(draft, card.source ?? SCHEDULE, event, rule ? [rule.name] : []);
  const decision = { choice: given.choice ?? null, answer: text, by: given.by ?? null, decided_at: draft.at };
  put(draft, "cards", id, { state: "decided", ...decision, answer_event: eventId, version: card.version + 1 });
  if (rule) enqueue(draft, rule, eventId, card.lane, card.agent === rule.to ? card.session : null);
  return { changed: true, state: "decided" };
}

function nextCard(draft: Draft, channel: string) {
  const { now } = draft;
  for (const card of draft.view.deliveryCandidates(channel, now)) {
    const key = `${card.id}:${channel}`;
    const delivery = draft.view.get("deliveries", key) ?? NOT_DELIVERED;
    const recentNote = card.fyi && Date.parse(card.created_at) >= now - 24 * 60 * MINUTE;
    const worthSending = card.state === "open" || delivery.ref !== null || recentNote;
    const resting = delivery.not_before && Date.parse(delivery.not_before) > now;
    if (card.quiet || delivery.version >= card.version || delivery.given_up || resting || !worthSending) continue;
    const firstTry = delivery.first_try_at;
    if (delivery.tries >= RESEND_AT.length || (firstTry && now - Date.parse(firstTry) > RESEND_WINDOW)) {
      put(draft, "deliveries", key, { given_up: 1 });
      continue;
    }
    const attempt = { tries: delivery.tries + 1, first_try_at: firstTry ?? draft.at, not_before: iso(now + MINUTE) };
    put(draft, "deliveries", key, { card_id: card.id, channel, ...attempt });
    return cardView(card, draft.env, delivery.ref, draft.rules.channels[channel]?.links === true);
  }
  return null;
}

/** What the clock has brought: schedules come round, reviews come due, and anything gone quiet. */
function tick(draft: Draft) {
  const { now } = draft;
  const { rules, timezone } = draft.rules;
  for (const rule of rules) {
    if (eventRule(rule)) continue;
    const text = cronOf(rule);
    const cron = parseCron(text)!;
    const schedule = draft.view.get("schedules", rule.name);
    const nextAt = () => iso(nextRun(cron, now, timezone)!);
    if (!schedule || schedule.cron !== text) {
      put(draft, "schedules", rule.name, { rule: rule.name, cron: text, next_at: nextAt() });
      continue;
    }
    if (now < Date.parse(schedule.next_at)) continue;
    const key = `${rule.name}@${iso(latestBefore(cron, Date.parse(schedule.next_at), now, timezone))}`;
    if (!rows(draft.view, "events", { source: SCHEDULE, key }).length) {
      enqueue(draft, rule, recordEvent(draft, SCHEDULE, { id: key, type: "schedule.tick" }, [rule.name]), "");
    }
    put(draft, "schedules", rule.name, { next_at: nextAt() });
  }
  const isDue = (timer: Row) => timer.event_id === null && Date.parse(timer.at) <= now;
  const due = rows(draft.view, "timers", { event_id: null }).filter(isDue);
  for (const timer of due.sort((a, b) => a.at.localeCompare(b.at))) {
    const candidate = ruleNamed(draft, timer.rule);
    const rule = candidate && !issueClosed(draft, candidate, timer.lane) ? candidate : undefined;
    const event = { id: `timer:${timer.id}`, type: "timer.due", subject: timer.lane, hops: timer.hops ?? 0 };
    const eventId = recordEvent(draft, timer.source, event, rule ? [rule.name] : []);
    put(draft, "timers", timer.id, { event_id: eventId });
    if (rule) enqueue(draft, rule, eventId, timer.lane, timer.session);
  }
  sweep(draft);
}

/** Every input there is, each with its arguments named. What one returns is what the caller is told. */
const HANDLERS: Record<string, (draft: Draft, ...args: any[]) => unknown> = {
  rules(draft, rules) {
    put(draft, "config", "rules", { value: rules, version: draft.seq });
    const named = new Set(rules.rules.map((rule: Rule) => rule.name));
    for (const run of rows(draft.view, "runs", { state: "queued" })) {
      if (named.has(run.rule)) assignQueued(draft, run);
      else stopRun(draft, run, "rule-gone", ...ruleGone(run));
    }
    closeOpen(draft, (key) => key.startsWith("rules:"), "改好了");
  },
  rulesError: (draft, problem) => notify(draft, `rules:${digest(problem)}`, "rules.json 写错了，还在用旧规则", problem),
  key: (draft, kind, name, hash) =>
    void put(draft, "keys", `${kind}:${name}`, { kind, name, hash, created_at: draft.at }),
  removeKey: (draft, kind, name) => {
    if (!draft.view.get("keys", `${kind}:${name}`)) return false;
    set(draft, "keys", `${kind}:${name}`, null);
    return true;
  },
  ingest,
  createCard,
  tell(draft, key, title, text) {
    const told = createCard(draft, { key, title, text, kind: "notice", fyi: true, once: true });
    if (!told.duplicate) return told;
    // Said again after every channel gave up on it: it gets another go.
    const isGivenUp = (delivery: Row) => delivery.card_id === told.card && delivery.given_up;
    const givenUp = rows(draft.view, "deliveries", { card_id: told.card }).filter(isGivenUp);
    for (const { card_id, channel } of givenUp) {
      put(draft, "deliveries", `${card_id}:${channel}`, { given_up: 0, ...NOT_TRYING });
    }
    if (!givenUp.length) return told;
    put(draft, "cards", told.card, { text, created_at: draft.at });
    return { ...told, duplicate: false };
  },
  heartbeat(draft, worker, running) {
    closeOffline(draft, worker);
    const held = (run?: Row) => run?.state === "claimed" && workerOf(draft.view, run) === worker;
    const inHand = running.map((id: number) => draft.view.get("runs", id)).filter(held);
    // All stamped together, so however many runs a worker has on, it's one fact each time.
    if ([draft.view.get("seen", `worker:${worker}`), ...inHand].every((row) => justSeen(draft, row))) return;
    put(draft, "seen", `worker:${worker}`, { kind: "worker", name: worker, seen_at: draft.at });
    for (const run of inHand) put(draft, "runs", run.id, { seen_at: draft.at });
  },
  channelSeen(draft, name) {
    if (justSeen(draft, draft.view.get("seen", `channel:${name}`))) return;
    put(draft, "seen", `channel:${name}`, { kind: "channel", name, seen_at: draft.at });
  },
  claimNext,
  started(draft, id, token, given) {
    const { session, link } = given ?? {};
    for (const [field, value] of Object.entries({ session, link })) {
      if (value !== undefined && (typeof value !== "string" || value.length > 500)) {
        throw new InputError(`${field} 要是 500 字以内的文字`);
      }
    }
    const run = heldRun(draft, id, token, ["claimed"]);
    if (run.lane?.startsWith("loop:")) {
      const stage = jobOf(draft.view, run, draft.env).context.approvedPlan ? "coding" : "planning";
      const current = draft.view.get("config", issueKey(run.rule, run.lane));
      if (!current?.stage || ["accepted", "planning", "plan_review", "coding"].includes(current.stage)) {
        if (current?.stage !== stage) businessStage(draft, run.rule, run.lane, stage);
      }
    }
    put(draft, "runs", id, { session: session ?? run.session, link: link ?? run.link, seen_at: draft.at });
  },
  finish,
  issueDisposition(draft, given) {
    const { target, action, reason } = given ?? {};
    if (target !== undefined) {
      if (
        (target?.kind !== "card" && target?.kind !== "run") ||
        !Number.isSafeInteger(target.id) ||
        target.id < 1 ||
        !["close", "reopen", "archive", "restore"].includes(action)
      )
        throw new InputError("任务或操作不正确");
      const { kind, id } = target;
      const task = draft.view.get(kind === "card" ? "cards" : "runs", id);
      if (!task || (kind === "card" ? task.run_id != null || task.kind !== "ask" : Boolean(task.lane)))
        throw new NotFound("没有这个独立任务");
      const key = `issue:task:${kind}:${id}`;
      const identity = { target: { kind, id }, rule: task.rule || "未归属", title: task.title || `第 ${id} 轮` };
      if (action === "close") {
        if (typeof reason !== "string" || !reason.trim() || reason.length > 500)
          throw new InputError("请填写 500 字以内的结案原因");
        if (kind === "run" && ["queued", "claimed", "unknown"].includes(task.state))
          throw new Conflict("轮次仍未结束，暂不能结案");
        if (draft.view.get("config", key)?.closed) return { ok: true };
        const cards = kind === "card" ? [task] : rows(draft.view, "cards", { run_id: id, state: "open" });
        for (const card of cards) {
          if (card.state === "open") closeCard(draft, card, reason.trim(), "本人");
        }
        put(draft, "config", key, { ...identity, closed: true, reason: reason.trim(), closedAt: draft.at });
      } else if (action === "reopen") {
        if (kind === "card") throw new Conflict("独立卡片结案后不能重新提交");
        put(draft, "config", key, { ...identity, closed: false, reason: null, closedAt: null });
      } else {
        put(draft, "config", key, { ...identity, archived: action === "archive" });
      }
      return { ok: true };
    }
    const { rule, subject, card: deliveryCard, version, environment, receipt, expectedStageAt } = given ?? {};
    if (
      typeof rule !== "string" ||
      !rule ||
      typeof subject !== "string" ||
      !subject ||
      subject.length > 500 ||
      ![
        "close",
        "reopen",
        "archive",
        "restore",
        "testing",
        "coded",
        "deployed",
        "delivered",
        "test-notified",
        "manual-test-notified",
        "released",
        "app-handoff",
        "app-note",
        "app-return",
        "local-debug-start",
        "local-debug-return",
        "set-display-status",
        "add-progress",
        "edit-progress",
        "add-local-record",
        "edit-local-record",
      ].includes(action)
    )
      throw new InputError("事项或操作不正确");
    const runs = rows(draft.view, "runs", { rule, lane: subject });
    if (!runs.length) throw new NotFound("没有这个事项");
    const key = issueKey(rule, subject);
    const current = draft.view.get("config", key);
    const active = runs.some((run) => ["queued", "claimed", "unknown"].includes(run.state));
    if (action === "add-local-record" || action === "edit-local-record") {
      if (typeof reason !== "string" || !reason.trim() || reason.length > 4000)
        throw new InputError("请填写 4000 字以内的处理记录");
      const records = [...localRecordsOf(current)];
      if (action === "add-local-record") {
        if (given.source !== "manual" && given.source !== "app") throw new InputError("请选择记录来源");
        records.push({ id: String(draft.seq), source: given.source, text: reason.trim(), at: draft.at });
      } else {
        const index = records.findIndex(({ id }) => id === given.record);
        const old = records[index];
        if (!old) throw new NotFound("找不到这条处理记录");
        if (old.text !== given.expectedText || (old.editedAt ?? null) !== given.expectedEditedAt)
          throw new Conflict("这条记录已更新，请刷新后再编辑");
        records[index] = { ...old, text: reason.trim(), editedAt: draft.at };
      }
      put(draft, "config", key, { rule, subject, localRecords: records });
      return { ok: true };
    }
    if (action === "set-display-status") {
      if (current?.closed) throw new Conflict("事项已结案");
      const status = given.status;
      if (typeof status !== "string" || (status !== "auto" && !Object.hasOwn(manualStatusLabels, status)))
        throw new InputError("请选择有效的展示状态");
      const label = status === current?.stage ? current.stageLabel : manualStatusLabels[status];
      const change = { status, label: status === "auto" ? "恢复自动状态" : label, at: draft.at };
      put(draft, "config", key, {
        rule,
        subject,
        manualStatus: status === "auto" ? null : change,
        manualStatusHistory: [...manualStatusHistory(current), change],
      });
      return { ok: true };
    }
    if (action === "add-progress" || action === "edit-progress") {
      if (typeof reason !== "string" || !reason.trim() || reason.length > 500)
        throw new InputError("请填写 500 字以内的进展说明");
      const notes = [...(current?.progressNotes ?? [])];
      if (action === "edit-progress") {
        const { index, expectedText, expectedEditedAt } = given;
        const note = Number.isSafeInteger(index) && index >= 0 ? notes[index] : undefined;
        if (!note) throw new NotFound("找不到这条手动进展");
        if (note.text !== expectedText || (note.editedAt ?? null) !== expectedEditedAt)
          throw new Conflict("这条进展已更新，请刷新后再编辑");
        if (note.text === reason.trim()) return { ok: true };
        notes[index] = { ...note, text: reason.trim(), editedAt: draft.at };
      } else {
        notes.push({ text: reason.trim(), at: draft.at });
      }
      put(draft, "config", key, {
        rule,
        subject,
        progressNotes: notes,
      });
      return { ok: true };
    }
    if (action === "manual-test-notified") {
      if (!subject.startsWith("loop:") || typeof receipt !== "string" || !receipt.trim() || receipt.length > 200)
        throw new InputError("缺少手动提测通知回执");
      if (current?.manualTestNotice?.receipt === receipt) return { ok: true };
      put(draft, "config", key, { rule, subject, manualTestNotice: { receipt, at: draft.at } });
      if (
        !active &&
        !current?.closed &&
        !["released", "testing"].includes(current?.stage) &&
        current?.stageAt === expectedStageAt
      ) {
        const card = current?.reviewCard && draft.view.get("cards", current.reviewCard);
        if (card?.state === "open") closeCard(draft, card, "已手动发送提测通知", "本人");
        businessStage(draft, rule, subject, "testing", { evidence: receipt, deployment: current?.deployment });
      }
      return { ok: true };
    }
    if (action === "local-debug-start" || action === "local-debug-return") {
      const { name, original, repo } = given;
      if (typeof name !== "string" || !/^[a-z][a-z0-9-]{0,99}$/.test(name)) throw new InputError("仓库名称不正确");
      const debug = current?.localDebug;
      if (action === "local-debug-return") {
        if (debug?.name !== name || debug.id !== given.handoff) throw new Conflict("本地调试状态已变化，请刷新");
        put(draft, "config", key, { rule, subject, localDebug: null });
        return { ok: true };
      }
      if (debug?.name === name) return { localDebug: debug };
      if (debug || current?.closed || runs.some(({ state }) => state === "claimed" || state === "unknown"))
        throw new Conflict("请先结束当前执行或交接，再接手本地调试");
      if (
        typeof original !== "string" ||
        !original.startsWith("refs/heads/") ||
        original.length > 500 ||
        typeof repo !== "string" ||
        !repo.startsWith("/") ||
        repo.length > 4096
      )
        throw new InputError("找不到原项目当前分支");
      const localDebug = { id: draft.seq, name, original, repo };
      put(draft, "config", key, { rule, subject, localDebug });
      return { localDebug };
    }
    if (action === "app-handoff") {
      if (runs.some(({ session_blocked }) => session_blocked)) throw new Conflict("请先重试被阻塞的原会话");
      if (
        current?.closed ||
        current?.appHandoff ||
        current?.localDebug ||
        runs.some((run) => ["claimed", "unknown"].includes(run.state))
      )
        throw new Conflict("请等当前轮次结束，再转 App 接手");
      const run = runs.find(({ id }) => id === given.run);
      if (
        !run?.session ||
        !/^[a-zA-Z0-9-]+$/.test(run.session) ||
        !/^[a-z][a-z0-9+.-]*:\/\/threads\/[a-zA-Z0-9-]+$/.test(run.link ?? "") ||
        !run.link.endsWith(`/${run.session}`)
      )
        throw new InputError("请选择有桌面会话链接的轮次");
      put(draft, "config", key, {
        rule,
        subject,
        appHandoff: { id: draft.seq, run: run.id, link: run.link, at: draft.at },
      });
      return { ok: true };
    }
    if (action === "app-note" || action === "app-return") {
      if (action === "app-return" && current?.localDebug) throw new Conflict("请先把本地调试分支交回任务工作区");
      const handoff = current?.appHandoff;
      if (!handoff || handoff.id !== given.handoff) throw new Conflict("App 接手记录已变化，请刷新");
      const records = localRecordsOf(current);
      const sessionOnly = action === "app-return" && Array.isArray(given.records) && given.records.length === 0;
      let text = typeof reason === "string" ? reason.trim() : "";
      if (action === "app-return" && given.records !== undefined) {
        if (!Array.isArray(given.records) || given.records.some((id: unknown) => typeof id !== "string"))
          throw new InputError("请选择要交回的处理记录");
        const ids = new Set(given.records);
        const chosen = records.filter(({ id }) => ids.has(id));
        if (chosen.length !== ids.size) throw new Conflict("所选处理记录已变化，请刷新");
        text = chosen.map((record) => record.text).join("\n\n");
      }
      if ((!text && !sessionOnly) || text.length > 4000) throw new InputError("请填写 4000 字以内的 App 操作结果");
      if (sessionOnly) text = "直接续接原会话。请根据会话中已有的 App 操作和对话继续处理。";
      const note = { text, at: draft.at };
      if (action === "app-note") {
        const notes = handoff.notes ?? (handoff.note ? [handoff.note] : []);
        put(draft, "config", key, {
          appHandoff: { ...handoff, note, notes: [...notes, note] },
          localRecords: [...records, { ...note, id: String(draft.seq), source: "app" }],
        });
        return { ok: true };
      }
      const targetRule = ruleNamed(draft, rule);
      const run = draft.view.get("runs", handoff.run);
      if (!targetRule?.parallel || !run) throw new Conflict("找不到接手轮次或当前规则已不支持按事项续办");
      const event = recordEvent(
        draft,
        sourceOf(draft.view, run.id) ?? SCHEDULE,
        {
          id: `app-handoff:${handoff.id}`,
          type: "app.returned",
          subject,
          summary: "负责人已从桌面应用交回",
          detail: text,
        },
        [rule],
      );
      const compatible =
        run.agent === targetRule.to && run.rules_version === draft.view.get("config", "rules")?.version;
      if (!compatible || !run.session) throw new Conflict("原会话执行配置已变化，无法交回原会话");
      const nextRun = enqueue(draft, targetRule, event, subject, run.session);
      put(draft, "runs", nextRun, { pinned_session: run.session });
      put(draft, "config", key, {
        appHandoff: null,
        appResult: { ...note, notes: handoff.notes ?? (handoff.note ? [handoff.note] : []) },
        localRecords:
          given.records !== undefined || records.at(-1)?.text === text
            ? records
            : [...records, { ...note, id: String(draft.seq), source: "app" }],
      });
      return { ok: true };
    }
    if (["coded", "deployed", "delivered", "test-notified", "released"].includes(action)) {
      if (!subject.startsWith("loop:") || current?.closed || active)
        throw new Conflict("事项仍在运行、已结案或不支持该业务阶段");
      const valid = (value: unknown, max: number) => typeof value === "string" && !!value.trim() && value.length <= max;
      if (action === "deployed") {
        if (!["coded", "test_branch_pushed"].includes(current?.stage)) throw new Conflict("请先记录编码完成");
        if (!valid(version, 150) || !valid(environment, 150) || !valid(reason, 1000))
          throw new InputError("请填写部署版本、测试环境和自测及部署核验结果");
        const latest = runs.reduce((previous, run) => (run.id > previous.id ? run : previous));
        const source = sourceOf(draft.view, latest.id);
        const origin = rows(draft.view, "events", { subject, source }).find((event) => event.type.endsWith(".created"));
        const deployment = { version: version.trim(), environment: environment.trim() };
        const result = createCard(draft, {
          key: `test-review:${key}:${deployment.version}`,
          once: true,
          kind: "ask",
          title: `${origin?.summary?.split(" ", 1)[0] ?? rule} · 确认通知需求方提测`,
          text: `部署版本：${deployment.version}\n测试环境：${deployment.environment}\n\n${reason.trim()}`,
          options: ["确认提测", "退回修改"],
          rule,
          lane: subject,
          source,
          run: latest.id,
          agent: latest.agent,
          session: latest.session,
          grp: latest.grp,
          source_title: origin?.summary,
          source_link: origin?.link,
        });
        if (result.duplicate) throw new Conflict("该版本已发过提测卡，请记录新的部署版本");
        businessStage(draft, rule, subject, "deployed", {
          deployment,
          reviewCard: result.card,
          evidence: reason.trim(),
        });
      } else if (action === "test-notified" || action === "released") {
        const stage = action === "test-notified" ? "testing" : "released";
        if (!valid(receipt, 200)) throw new InputError("缺少通知发送回执");
        if (current?.stage === stage && current.evidence === receipt) return { ok: true };
        if (
          current?.stageAt !== expectedStageAt ||
          (action === "test-notified" && current?.stage !== "test_approved") ||
          (action === "released" && current?.stage === "deployed")
        )
          throw new Conflict("当前阶段已变化，请核对通知回执");
        businessStage(draft, rule, subject, stage, { evidence: receipt, deployment: current?.deployment });
      } else {
        if (!valid(reason, 1000)) throw new InputError("请填写核验记录");
        if (["deployed", "test_approved", "testing", "released"].includes(current?.stage))
          throw new Conflict("该事项已进入提测或上线阶段");
        if (deliveryCard !== undefined) {
          const card = draft.view.get("cards", deliveryCard);
          if (
            action !== "delivered" ||
            !card ||
            card.rule !== rule ||
            card.lane !== subject ||
            card.state !== "open" ||
            card.kind !== "ask" ||
            card.plan_approval ||
            card.key.startsWith("test-review:")
          )
            throw new Conflict("交付卡已变化，或不属于该事项");
          closeCard(draft, card, reason.trim(), "本人");
        }
        businessStage(draft, rule, subject, action, { evidence: reason.trim() });
      }
    } else if (action === "testing") {
      if (subject.startsWith("loop:")) throw new Conflict("Octo 事项须凭提测通知回执推进阶段");
      const current = draft.view.get("config", key);
      if (current?.closed || runs.some((run) => ["queued", "claimed", "unknown"].includes(run.state)))
        throw new Conflict("事项已结案或仍有未结束的轮次，暂不能标记提测");
      if (deliveryCard !== undefined) {
        const card = draft.view.get("cards", deliveryCard);
        if (
          !card ||
          card.rule !== rule ||
          card.lane !== subject ||
          card.state !== "open" ||
          card.kind !== "ask" ||
          card.plan_approval ||
          typeof reason !== "string" ||
          !reason.trim() ||
          reason.length > 1000
        )
          throw new Conflict("交付卡已变化，或不属于该事项");
        closeCard(draft, card, reason.trim(), "本人");
      }
      if (current?.stage !== "testing")
        put(draft, "config", key, { rule, subject, stage: "testing", stageAt: draft.at });
    } else if (action === "close") {
      if (current?.localDebug) throw new Conflict("请先交回本地调试的需求分支");
      if (current?.appHandoff) throw new Conflict("请先交回 App 接手任务");
      if (typeof reason !== "string" || !reason.trim() || reason.length > 500)
        throw new InputError("请填写 500 字以内的结案原因");
      if (runs.some((run) => ["queued", "claimed", "unknown"].includes(run.state)))
        throw new Conflict("还有排队、运行或状态待核对的轮次，暂不能结案");
      if (draft.view.get("config", key)?.closed) return { ok: true };
      for (const card of rows(draft.view, "cards", { rule, lane: subject, state: "open" })) {
        closeCard(draft, card, "事项已人工结案", "本人");
      }
      put(draft, "config", key, {
        rule,
        subject,
        closed: true,
        reason: reason.trim(),
        closedAt: draft.at,
        stage: null,
        manualStatus: null,
        ...(current?.manualStatus && { manualStatusHistory: manualStatusHistory(current) }),
        stageLabel: null,
        stageAt: null,
      });
    } else if (action === "reopen") {
      put(draft, "config", key, { rule, subject, closed: false, reason: null, closedAt: null });
    } else {
      put(draft, "config", key, { rule, subject, archived: action === "archive" });
    }
    return { ok: true };
  },
  retrySession(draft, id, input?: { note?: unknown }) {
    const note = input?.note;
    if (note !== undefined && (typeof note !== "string" || note.length > 500))
      throw new InputError("补充说明最多 500 字");
    const detail = note?.trim();
    const run = draft.view.get("runs", id);
    if (!run) throw new NotFound("没有这一轮");
    const rule = ruleNamed(draft, run.rule);
    const issue = draft.view.get("config", issueKey(run.rule, run.lane));
    const session = run.pinned_session ?? run.session;
    if (
      !rule?.parallel ||
      !run.lane ||
      !session ||
      rule.to !== run.agent ||
      issue?.closed ||
      issue?.appHandoff ||
      issue?.localDebug
    )
      throw new Conflict("任务当前无法续接原会话");
    if (!run.session_blocked) {
      const same = rows(draft.view, "runs", { rule: run.rule, lane: run.lane });
      if (same.some(({ state }) => ["queued", "claimed", "unknown"].includes(state)))
        throw new Conflict("任务还有未结束的轮次");
      if (same.some((other) => other.id > run.id && other.session)) throw new Conflict("已有更新的会话，请刷新后重试");
      const event = recordEvent(
        draft,
        SCHEDULE,
        {
          id: `session-retry:${draft.seq}`,
          type: "session.retry",
          subject: run.lane,
          summary: "负责人请求续办原会话",
          detail: detail || "核对当前进展，从未完成的步骤继续。已完成的操作不要重复执行。",
        },
        [run.rule],
      );
      const next = enqueue(draft, rule, event, run.lane, session);
      put(draft, "runs", next, { pinned_session: session });
      return;
    }
    if (run.state !== "queued") throw new Conflict("这轮没有可重试的原会话");
    if (detail) {
      const event = recordEvent(
        draft,
        sourceOf(draft.view, id) ?? SCHEDULE,
        {
          id: `session-retry:${draft.seq}`,
          type: "session.retry",
          subject: run.lane,
          summary: "负责人补充续办说明",
          detail,
        },
        [run.rule],
      );
      put(draft, "run_events", `${id}:${event}`, { run_id: id, event_id: event });
    }
    put(draft, "runs", id, {
      state: "queued",
      attempts: run.attempts + 1,
      session_blocked: false,
      resume: session,
      not_before: draft.at,
      ...nulls("finished_at", "claimed_at", "seen_at", "error", "claim"),
    });
  },
  cancel(draft, id) {
    const run = draft.view.get("runs", id);
    if (!run) throw new NotFound("没有这一轮");
    if (run.state === "queued")
      put(draft, "runs", id, {
        state: "cancelled",
        finished_at: draft.at,
        ...(run.session_blocked && { session_blocked: false }),
      });
    else if (run.state === "claimed") put(draft, "runs", id, { cancel_at: draft.at });
    else throw new InputError("这一轮已经结束了");
  },
  resolve(draft, id, reason, by) {
    const card = draft.view.get("cards", id);
    if (!card) throw new NotFound("没有这张卡片");
    if (card.state !== "open") return false;
    if (card.key.startsWith("test-review:")) throw new Conflict("请使用提测卡的确认或退回选项");
    closeCard(draft, card, reason, by);
    return true;
  },
  answer,
  nextCard,
  delivered(draft, channel, id, version, ref) {
    if (!draft.view.get("cards", id)) throw new NotFound("没有这张卡片");
    if (ref !== null && (typeof ref !== "string" || [...ref].length > DELIVERY_REF)) {
      throw new InputError(`消息编号最多 ${DELIVERY_REF} 字`);
    }
    const delivery = draft.view.get("deliveries", `${id}:${channel}`) ?? NOT_DELIVERED;
    const sent = { version: Math.max(delivery.version, version), ref: delivery.ref ?? ref };
    put(draft, "deliveries", `${id}:${channel}`, { card_id: id, channel, ...sent, ...NOT_TRYING, error: null });
  },
  failed(draft, channel, id, version, error) {
    const card = draft.view.get("cards", id);
    const delivery = draft.view.get("deliveries", `${id}:${channel}`);
    if (!card || !delivery) throw new NotFound("这张卡片没有交给这个通道");
    const firstTry = delivery.first_try_at ? Date.parse(delivery.first_try_at) : draft.now;
    const next =
      version < card.version
        ? { not_before: null }
        : delivery.tries >= RESEND_AT.length
          ? { given_up: 1 }
          : { not_before: iso(firstTry + RESEND_AT[delivery.tries] * MINUTE) };
    put(draft, "deliveries", `${id}:${channel}`, { ...next, error: String(error).slice(0, 300) });
  },
  sweep,
  tick,
};
