import type { Rule, Worktree } from "../kernel/rules.ts";

export const requiresOriginalSession = (type: string) => type === "app.returned" || type === "session.retry";
export type Job = {
  run: number;
  token: string;
  attempt: number;
  rule: Pick<
    Rule,
    "name" | "cwd" | "skill" | "prompt" | "emits" | "repositories" | "planApproval" | "prepareWorktrees"
  > & {
    worktrees?: Record<string, Worktree>;
  };
  agent: {
    id: string;
    name: string;
    use: string;
    model?: string;
    effort?: string;
    access: string;
    command?: string[];
    timeout?: number;
  };
  session: string | null;
  askFirst: string[];
  context: {
    approvedPlan?: string;
    approvedRepositories?: string[];
    issueSubject?: string;
    previousSessions?: string[];
    continuity?: {
      originalIssue?: { summary: string; detail: string; link: string };
      previousPlan?: { card: number; title: string; text: string; repositories?: string[]; note?: string };
      recentRuns: { run: number; state: string; summary: string }[];
      recentInputs: { type: string; summary: string; detail: string }[];
      recentDecisions: { card: number; title: string; choice: string | null; note: string | null }[];
    };
    events: {
      id: string;
      source: string;
      sourceName: string;
      type: string;
      subject: string;
      summary: string;
      detail: string;
      link: string;
      receivedAt: string;
      hops?: number;
    }[];
    answers: {
      card: number;
      title: string;
      options: string[];
      choice: number | null;
      text: string | null;
      about: string;
      by: string | null;
      at: string;
    }[];
    timers: { key: string; about: string; at: string }[];
    waiting: { key: string; about: string; at: string }[];
    open: { card: number; title: string; text: string; at: string; requiresApproval?: boolean }[];
    decided: { card: number; title: string; choice: string | null; at: string }[];
  };
};
