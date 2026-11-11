// Reading the view: what the decisions and the doors ask of it, and the shapes they hand out.
import { credential, type Environment } from "./credentials.ts";
import { rows, type Fact, type Row, type View } from "./evolve.ts";
import { worktreesOf, type Rules } from "./rules.ts";
import type { Job } from "../protocol/job.ts";

export function configuration(view: View, version?: number): Rules {
  const current = view.get("config", "rules");
  return (version === undefined || version === current?.version ? current : view.get("config", version))?.value;
}
export const workerOf = (view: View, run: Row) => configuration(view, run.rules_version).agents[run.agent]?.worker;
export function agentsOf(view: View, worker: string) {
  const agents = Object.entries(configuration(view).agents);
  return agents.filter(([, agent]) => agent.worker === worker).map(([id]) => id);
}
export const workers = (view: View) =>
  new Set([
    ...Object.values(configuration(view)?.agents ?? {}).map((agent) => agent.worker),
    ...rows(view, "runs", { state: "claimed" }).map((run) => workerOf(view, run)!),
  ]);

/** What a worker's agents have on: runs in hand and runs ready to be claimed. */
export function waitingOn(view: View, worker: string, now: number) {
  const ready = (run: Row) => run.state === "queued" && !run.session_blocked && Date.parse(run.not_before) <= now;
  return rows(view, "runs", { state: ["queued", "claimed"] }).filter(
    (run) => workerOf(view, run) === worker && (run.state === "claimed" || ready(run)),
  );
}

export function eventsOf(view: View, runId: number) {
  const links = rows(view, "run_events", { run_id: runId });
  return links.map((link) => view.get("events", link.event_id)!).sort((a, b) => a.id - b.id);
}

export function sourceOf(view: View, runId: number) {
  const sources = [...new Set(eventsOf(view, runId).map((event) => event.source))];
  return sources.length === 1 ? sources[0] : null;
}

/** The cards a run may close: open before it was claimed, from the same source and group. */
export function openInScope(view: View, run: Row) {
  if (run.lane && run.claimed_at && eventsOf(view, run.id).some(({ type }) => type === "app.returned")) {
    return rows(view, "cards", { state: "open", rule: run.rule, lane: run.lane }).filter(
      (card) => card.created_at <= run.claimed_at,
    );
  }
  const source = sourceOf(view, run.id);
  if (!source || !run.claimed_at) return [];
  const inScope = (card: Row) => card.grp === run.grp && card.source === source && card.created_at <= run.claimed_at;
  return rows(view, "cards", { state: "open", grp: run.grp, source }).filter(inScope);
}

export function cardHistory(view: View, scope: { rule: string; lane: string } | { id: number } | { run_id: number }) {
  return rows(view, "cards", { ...scope, kind: "ask", state: ["decided", "done", "closed"] }).sort(
    (a, b) =>
      (b.decided_at ?? b.closed_at ?? b.created_at).localeCompare(a.decided_at ?? a.closed_at ?? a.created_at) ||
      b.id - a.id,
  );
}

export function cardView(card: Row, env: Environment, ref: string | null = null, links = false) {
  const { id, version, kind, state, title, text, recommend, choice, answer, by, result } = card;
  const options: string[] = kind === "ask" ? JSON.parse(card.options) : state === "open" ? ["已处理"] : [];
  const link = links ? `${env.publicUrl.replace(/\/$/, "")}/c/${credential(env, "card", id, card.created_at)}` : null;
  const when = { createdAt: card.created_at, decidedAt: card.decided_at, closedAt: card.closed_at };
  return {
    id,
    version,
    ref,
    kind,
    state,
    title,
    text,
    options,
    recommend,
    choice,
    answer,
    by,
    result,
    link,
    rule: card.rule,
    ...(card.plan_approval && { planApproval: true }),
    ...(card.key?.startsWith("test-review:") && { testReview: true }),
    ...(card.source_link && { sourceLink: card.source_link }),
    ...(card.source_title && { sourceTitle: card.source_title }),
    ...when,
  };
}

export function isCurrentPlan(view: View, card: Row, agent: string, rulesVersion: number): boolean {
  if (!card.lane || !card.source || card.agent !== agent) return false;
  const proposal = view.get("runs", card.run_id);
  if (!proposal || proposal.rules_version !== rulesVersion) return false;
  const lastEvent = Math.max(0, ...eventsOf(view, proposal.id).map((event) => event.id));
  const newerPlan = rows(view, "cards", { rule: card.rule, lane: card.lane }).some(
    (other) => other.plan_approval && other.id > card.id,
  );
  const newerInput = rows(view, "events", { source: card.source, subject: card.lane }).some(
    (event) => event.id > lastEvent && event.id !== card.answer_event && JSON.parse(event.routed).includes(card.rule),
  );
  return !newerPlan && !newerInput;
}

export function jobOf(view: View, run: Row, env: Environment): Job {
  const rules = configuration(view, run.rules_version);
  const rule = rules.rules.find((rule) => rule.name === run.rule)!;
  const { name, cwd, skill, prompt, emits, repositories, planApproval, prepareWorktrees } = rule;
  const worktrees = worktreesOf(rule, run.lane);
  const events = eventsOf(view, run.id);
  const eventIds = events.map((event) => event.id);
  const thread = { rule: run.rule, lane: run.lane };
  const previousSessions = run.lane
    ? [
        ...new Set(
          rows(view, "runs", { ...thread, agent: run.agent, session: { not: null } })
            .filter(
              (previous) =>
                previous.id < run.id &&
                configuration(view, previous.rules_version).agents[previous.agent]?.use === rules.agents[run.agent].use,
            )
            .map(({ session }) => session as string),
        ),
      ]
    : [];
  const answers = rows(view, "cards", { ...thread, answer_event: eventIds });
  const approval =
    planApproval && eventIds.length === 1 ? answers.find((card) => card.plan_approval && card.choice === 0) : undefined;
  const approvedPlan =
    approval && isCurrentPlan(view, approval, run.agent, run.rules_version) ? approval.text : undefined;
  const timers = rows(view, "timers", { ...thread, event_id: eventIds });
  const waiting = rows(view, "timers", { ...thread, event_id: null });
  const decided = ["decided", "done"]
    .flatMap((state) => rows(view, "cards", { ...thread, state }, 20, true))
    .sort((a, b) => b.id - a.id)
    .slice(0, 20);
  const prior = run.lane
    ? rows(view, "runs", { ...thread, state: ["done", "nothing", "cancelled"] }, 4, true).filter(
        ({ id }) => id < run.id,
      )
    : [];
  let continuity: Job["context"]["continuity"];
  if (prior.length) {
    const previousPlan = rows(
      view,
      "cards",
      { ...thread, state: ["decided", "done"], plan_approval: 1, choice: 0 },
      1,
      true,
    )[0];
    const first = rows(view, "runs", thread, 1)[0];
    const original = first && eventsOf(view, first.id).find(({ type }) => type.endsWith(".created"));
    const recentInputs = new Map<number, Row>();
    for (const previous of prior) {
      for (const input of eventsOf(view, previous.id)) {
        if (!eventIds.includes(input.id) && (input.type.endsWith(".comment") || input.type === "app.returned"))
          recentInputs.set(input.id, input);
      }
    }
    continuity = {
      ...(original && { originalIssue: { summary: original.summary, detail: original.detail, link: original.link } }),
      ...(previousPlan && {
        previousPlan: {
          card: previousPlan.id,
          title: previousPlan.title,
          text: previousPlan.text,
          ...(previousPlan.repositories && { repositories: previousPlan.repositories }),
          ...(previousPlan.answer && { note: previousPlan.answer }),
        },
      }),
      recentRuns: prior.map(({ id, state, summary, error }) => ({ run: id, state, summary: summary || error || "" })),
      recentInputs: [...recentInputs.values()]
        .sort((a, b) => b.id - a.id)
        .slice(0, 3)
        .map(({ type, summary, detail }) => ({ type, summary, detail })),
      recentDecisions: decided
        .filter((card) => !eventIds.includes(card.answer_event))
        .slice(0, 4)
        .map(({ id, title, choice, answer, options }) => ({
          card: id,
          title,
          choice: choice == null ? null : (JSON.parse(options)[choice] ?? null),
          note: answer,
        })),
    };
  }
  const timerView = (timer: Row) => ({ key: timer.key, about: timer.about, at: timer.at });
  return {
    run: run.id,
    token: credential(env, "run", run.id, run.issued),
    attempt: run.attempts + 1,
    rule: {
      name,
      cwd,
      skill,
      prompt,
      emits,
      ...(repositories !== undefined && { repositories }),
      ...(worktrees && { worktrees }),
      ...(planApproval && { planApproval }),
      ...(prepareWorktrees && { prepareWorktrees }),
    },
    agent: {
      ...rules.agents[run.agent],
      id: run.agent,
      ...(planApproval && !approvedPlan && rules.agents[run.agent].access !== "full" && { access: "read" }),
    },
    session: run.pinned_session ?? run.session ?? run.resume,
    askFirst: rules.askFirst,
    context: {
      ...(approvedPlan && { approvedPlan }),
      ...(prepareWorktrees && { issueSubject: run.lane }),
      ...(approvedPlan && approval?.repositories && { approvedRepositories: approval.repositories }),
      ...(continuity && { continuity }),
      ...(previousSessions.length && { previousSessions }),
      events: events.map(({ key: id, source, type, subject, summary, detail, link, received_at: receivedAt, hops }) => {
        const sourceName = rules.sources[source]?.name ?? source;
        return { id, source, sourceName, type, subject, summary, detail, link, receivedAt, hops: hops ?? 0 };
      }),
      answers: answers.map(({ id: card, title, options, choice, answer: text, about, by, decided_at: at }) => {
        return { card, title, options: JSON.parse(options), choice, text, about, by, at };
      }),
      timers: timers.filter((timer) => eventIds.includes(timer.event_id)).map(timerView),
      waiting: waiting.sort((a, b) => a.at.localeCompare(b.at)).map(timerView),
      open: openInScope(view, run).map(({ id, title, text, created_at, plan_approval, key }) => ({
        card: id,
        title,
        text,
        at: created_at,
        ...(plan_approval || key.startsWith("test-review:") ? { requiresApproval: true } : {}),
      })),
      decided: decided
        .filter((card) => !answers.some((answer) => answer.id === card.id))
        .map(({ id, title, choice, answer, options, decided_at }) => {
          return { card: id, title, choice: choice === null ? answer : JSON.parse(options)[choice], at: decided_at };
        }),
    },
  };
}

export function cancels(view: View, worker: string): number[] {
  const stopping = (run: Row) => run.state === "claimed" && run.cancel_at !== null && workerOf(view, run) === worker;
  return rows(view, "runs", { state: "claimed" })
    .filter(stopping)
    .map((run) => run.id);
}

export function unrouted(view: View, limit = 20) {
  return rows(view, "events", { routed: "[]" }, limit, true);
}

export const safeFact = (fact: Fact) => ({ ...fact, changes: fact.changes.filter(({ table }) => table !== "keys") });
