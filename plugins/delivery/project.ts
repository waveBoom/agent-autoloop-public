// A project's delivery settings and what they say about a release. The Ship action runs from a copy of this file in the
// project, so it imports nothing beyond Node.
import { execFileSync, spawnSync } from "node:child_process";

export type Settings = {
  repo: string;
  internal: string[];
  admin_merge: string[];
  check: { workflow: string; job: string };
  ship: { workflow: string };
  review: { points: string; xhigh: string[]; status: string; command?: string[] };
  health?: { url: string; require: Record<string, unknown>; field: string; pattern: string };
};
export type Live = { sha: string; release: string };

const SETTINGS_KEYS = ["repo", "internal", "admin_merge", "check", "ship", "review", "health"];
const isWords = (value: unknown): value is string[] =>
  Array.isArray(value) && value.every((word) => typeof word === "string" && word.length > 0);
const isPaths = (value: unknown) =>
  isWords(value) && value.every((path) => !path.startsWith("/") && !path.split("/").includes(".."));
/** Settings may write a named group the way Python does; JavaScript only reads the other way. */
const jsPattern = (pattern: string) => pattern.replace("(?P<sha>", "(?<sha>");

export function settings(value: any, testLocalHealth = false): Settings {
  const bad = () => {
    throw new Error("ops/delivery.json 的设置不正确");
  };
  if (!value || !/^[\w.-]+\/[\w.-]+$/.test(value.repo ?? "") || !isPaths(value.internal)) bad();
  if (Object.keys(value).some((key) => !SETTINGS_KEYS.includes(key))) bad();
  const { review, health } = value;
  if (!review || !isPaths([review.points]) || (review.xhigh !== undefined && !isPaths(review.xhigh))) bad();
  if (review.command !== undefined && (!isWords(review.command) || !review.command.length)) bad();
  if (review.status !== undefined && (typeof review.status !== "string" || !review.status.trim())) bad();
  if (value.admin_merge !== undefined && !isWords(value.admin_merge)) bad();
  for (const workflow of [value.check?.workflow, value.ship?.workflow]) {
    if (workflow !== undefined && !/^[\w.-]+\.ya?ml$/.test(workflow)) bad();
  }
  if (value.check?.job !== undefined && (typeof value.check.job !== "string" || !value.check.job)) bad();
  if (health) {
    const url = new URL(health.url);
    const secure =
      url.protocol === "https:" || (testLocalHealth && url.protocol === "http:" && url.hostname === "127.0.0.1");
    if (!secure || url.username || url.password) bad();
    if (typeof health.field !== "string" || typeof health.pattern !== "string") bad();
    if (!/\(\?(?:P)?<sha>/.test(health.pattern)) bad();
    new RegExp(jsPattern(health.pattern));
    const { require } = health;
    if (require !== undefined && (!require || typeof require !== "object" || Array.isArray(require))) bad();
  }
  return {
    ...value,
    admin_merge: value.admin_merge ?? [],
    check: { workflow: "check.yml", job: "check", ...value.check },
    ship: { workflow: "ship.yml", ...value.ship },
    review: { xhigh: [], status: "agent-review", ...review },
    ...(health && { health: { require: {}, ...health } }),
  };
}

export function git(root: string, ...args: string[]) {
  return execFileSync("git", ["-c", "core.hooksPath=/dev/null", "-c", "core.fsmonitor=false", ...args], {
    cwd: root,
    encoding: "utf8",
    timeout: 60000,
    maxBuffer: 32 * 1024 * 1024,
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

export function readMainSettings(root: string, testLocalHealth = false, ref = "origin/main") {
  return settings(JSON.parse(git(root, "show", `${ref}:ops/delivery.json`)), testLocalHealth);
}

function globToRegExp(pattern: string) {
  const parts = pattern.split(/(\*\*\/|\*)/).map((part) => {
    if (part === "**/") return "(?:.*/)?";
    if (part === "*") return "[^/]*";
    return part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  });
  return new RegExp(`^${parts.join("")}$`);
}

export const matches = (name: string, patterns: string[]) =>
  patterns.some((pattern) => globToRegExp(pattern).test(name));

export function releaseRequired(root: string, base: string, head: string, patterns: string[]) {
  const isAncestor = spawnSync("git", ["merge-base", "--is-ancestor", base, head], { cwd: root, stdio: "ignore" });
  if (isAncestor.status !== 0) return true;
  const records = git(
    root,
    "diff",
    "--raw",
    "-z",
    "--no-renames",
    "--no-ext-diff",
    "--no-textconv",
    base,
    head,
    "--",
  ).split("\0");
  for (let index = 0; index + 1 < records.length; index += 2) {
    const modes = records[index].replace(/^:/, "").split(" ").slice(0, 2);
    const plainFile = modes.every((mode) => ["000000", "100644"].includes(mode));
    if (!plainFile || !matches(records[index + 1], patterns)) return true;
  }
  return false;
}

export async function liveRelease(config: Settings, request: typeof fetch = fetch): Promise<Live | null> {
  if (!config.health) return null;
  const { url, require, field, pattern } = config.health;
  try {
    const response = await request(url, {
      signal: AbortSignal.timeout(15000),
      redirect: "error",
      headers: { "cache-control": "no-cache" },
    });
    if (!response.ok) return null;
    const body = await response.json();
    if (!body || Object.entries(require).some(([key, value]) => body[key] !== value)) return null;
    if (typeof body[field] !== "string") return null;
    const release = body[field];
    const sha = new RegExp(`^(?:${jsPattern(pattern)})$`).exec(release)?.groups?.sha;
    return sha && /^[a-f0-9]{7,40}$/.test(sha) ? { sha, release } : null;
  } catch {
    return null;
  }
}
