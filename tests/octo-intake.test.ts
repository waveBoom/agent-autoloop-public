// Prevent a different sender, a replay or a lost create response from creating a second Issue.
import assert from "node:assert/strict";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { intake } from "../plugins/octo/intake.ts";
import { handleGatewayIntake } from "../plugins/octo/intake-gateway.ts";

const message = {
  channel: "thread",
  sender: "requester",
  message: "100",
  text: "/提需求 指派给 示例处理人\nSYNC 播放失败",
};
const assignee = { uid: "wang", name: "示例处理人" };
const draft = { title: "SYNC 播放失败", description: "播放器报错。验收：可以正常播放。" };

test("the Gateway keeps the intake database open until the async draft is stored", async () => {
  const dir = mkdtempSync(join(tmpdir(), "autoloop-intake-gateway-"));
  const dataDir = join(dir, "data");
  mkdirSync(dataDir);
  const cli = join(dir, "octo-fixture");
  writeFileSync(
    cli,
    `#!/bin/sh\nprintf '%s\\n' '{"ok":true,"data":[{"uid":"requester","name":"Requester","robot":0},{"uid":"wang","name":"示例处理人","robot":0}]}'\n`,
    { mode: 0o700 },
  );
  const rulesFile = join(dir, "rules.json");
  writeFileSync(
    rulesFile,
    JSON.stringify({
      sources: { app: { name: "App" } },
      agents: { codex: { name: "Codex", use: "codex", worker: "local" } },
      rules: [
        {
          name: "SYNC",
          aliases: ["sync"],
          keywords: ["SYNC"],
          when: { source: "app", types: ["task.created"] },
          to: "codex",
          cwd: dir,
          prompt: "处理",
        },
      ],
    }),
  );
  writeFileSync(
    join(dir, "intake.json"),
    JSON.stringify({
      botId: "bot",
      apiOrigin: "https://example.invalid",
      workspaceId: "workspace",
      channelId: "thread",
      rulesFile,
      cli,
    }),
  );
  const result = await handleGatewayIntake(
    { botId: "bot", apiUrl: "https://example.invalid", botToken: "fixture", dataDir },
    { ...message, channelType: 5 },
    async () => draft,
  );
  assert.match(result ?? "", /指派给：示例处理人/);
  using db = new DatabaseSync(join(dataDir, "intake.sqlite"), { readOnly: true });
  assert.equal(db.prepare("SELECT count(*) AS n FROM octo_intake WHERE state='draft'").get()?.n, 1);
});

test("unclear project or missing requirements cannot produce a confirmable draft", async () => {
  using db = new DatabaseSync(":memory:");
  let summaries = 0;
  const handle = intake(db, {
    allowed: async () => true,
    resolveAssignee: async () => assignee,
    checkProject: (content) => (content.includes("SYNC") ? "sync" : undefined),
    summarize: async () => {
      summaries++;
      return { ...draft, questions: ["影响哪些用户？"] };
    },
    create: async () => assert.fail("an unclear Issue must not be created"),
  });
  const unclear = await handle({ ...message, text: "/提需求 指派给 示例处理人\n播放失败" });
  assert.match(unclear!, /项目：规则别名/);
  assert.equal(summaries, 0);
  const missing = await handle(message);
  assert.match(missing!, /影响哪些用户/);
  assert.doesNotMatch(missing!, /确认提需求/);
  assert.equal(db.prepare("SELECT count(*) AS n FROM octo_intake").get()?.n, 0);
});

test("only the submitting person in the original channel can confirm the saved draft", async () => {
  using db = new DatabaseSync(":memory:");
  let created = 0;
  const handle = intake(db, {
    allowed: async () => true,
    resolveAssignee: async (value) => (value === assignee.name ? assignee : undefined),
    summarize: async () => draft,
    create: async (input) => {
      assert.equal(input.requester, "requester");
      assert.equal(input.message, "100");
      assert.deepEqual(input.draft, draft);
      assert.deepEqual(input.assignee, assignee);
      created++;
      return { id: "issue-1", url: "https://octo.example/issue-1" };
    },
  });
  const preview = await handle(message);
  assert.match((await handle({ ...message, text: "/提需求 缺少指派人" }))!, /指派给/);
  assert.match(preview ?? "", /SYNC 播放失败/);
  assert.match(preview ?? "", /指派给：示例处理人/);
  assert.equal(await handle(message), preview);
  const text = preview!.match(/\/确认提需求 [a-f0-9]+/)![0];
  assert.equal(created, 0);
  assert.match((await handle({ ...message, sender: "other", text }))!, /找不到/);
  assert.match((await handle({ ...message, channel: "other", text }))!, /找不到/);
  assert.match((await handle({ ...message, text }))!, /https:\/\/octo.example\/issue-1/);
  await handle({ ...message, text });
  assert.equal(created, 1);
});

test("an uncertain create response cannot be replayed", async () => {
  using db = new DatabaseSync(":memory:");
  let attempts = 0;
  const handle = intake(db, {
    allowed: async () => true,
    resolveAssignee: async () => assignee,
    summarize: async () => draft,
    create: async () => {
      attempts++;
      throw new Error("response lost");
    },
  });
  const text = (await handle(message))!.match(/\/确认提需求 [a-f0-9]+/)![0];
  assert.match((await handle({ ...message, text }))!, /需人工核对/);
  assert.match((await handle({ ...message, text }))!, /需人工核对/);
  assert.equal(attempts, 1);
});
