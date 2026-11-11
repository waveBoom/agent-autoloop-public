import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

function readUrl(value: unknown) {
  if (value === undefined) return;
  if (typeof value !== "string") throw new Error("测试地址须为 HTTPS URL");
  const url = new URL(value);
  if (url.protocol !== "https:" || url.username || url.password) throw new Error("测试地址须为不含凭据的 HTTPS URL");
  return url.href;
}

export function readTestDeliveryProfile(file: string) {
  const { testUrl, testRequest, repositories } = JSON.parse(readFileSync(file, "utf8"));
  const requestUrl = testRequest === undefined ? undefined : readUrl(testRequest?.url);
  if (testRequest !== undefined && (testRequest?.method !== "POST" || !requestUrl)) {
    throw new Error("测试请求须包含 POST 方法及有效 URL");
  }
  if (!repositories || typeof repositories !== "object" || Array.isArray(repositories)) {
    throw new Error("须明确配置参与测试的仓库");
  }
  const entries = Object.entries(repositories);
  if (!entries.length) throw new Error("至少配置一个测试仓库");
  const configured = entries.map(([alias, value]) => {
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("仓库测试配置无效");
    const entry = value as { testBranch?: unknown; testUrl?: unknown };
    const branch = entry.testBranch === undefined ? "develop" : entry.testBranch;
    if (
      !/^[a-z][a-z0-9_-]*$/.test(alias) ||
      typeof branch !== "string" ||
      !/^[A-Za-z0-9][A-Za-z0-9._/-]*$/.test(branch) ||
      /\.\.|(^|\/)\.|\/\/|\.lock(\/|$)|[./]$/.test(branch) ||
      /^(refs\/|main$|master$)/.test(branch)
    ) {
      throw new Error("测试分支必须是明确的独立分支，不能用主分支或 Git 引用");
    }
    const url = readUrl(entry.testUrl);
    return [alias, { testBranch: branch, ...(url && { testUrl: url }) }] as const;
  });
  return {
    testUrl: readUrl(testUrl),
    repositories: Object.fromEntries(configured),
    ...(requestUrl && { testRequest: { method: "POST" as const, url: requestUrl } }),
  };
}

export function configuredTestAddress(cwd?: string) {
  if (!cwd) return;
  const file = join(cwd.replace(/^~(?=\/)/, homedir()), "test-delivery.json");
  if (!existsSync(file)) return;
  const { testUrl, testRequest, repositories } = readTestDeliveryProfile(file);
  return testRequest
    ? `POST ${testRequest.url}`
    : (testUrl ?? Object.values(repositories).find((repo) => repo.testUrl)?.testUrl);
}
