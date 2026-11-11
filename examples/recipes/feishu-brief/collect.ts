// Keep Feishu credentials in its CLI; only complete, reader-scoped snapshots can wake the summarizer.
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

type Report = {
  task_id: string;
  rule_name: string;
  from_user_id: string;
  commit_time: number;
  form_contents: unknown[];
};
type Table = { name: string; baseToken: string; tableId: string; fields: string[]; url: string };
type Sources = { reportRule: string; reportUsers: string[]; tables: Table[] };
class AuthorizationError extends Error {}

function lark(args: string[]) {
  const run = spawnSync("lark-cli", [...args, "--as", "user"], {
    encoding: "utf8",
    timeout: 60_000,
    maxBuffer: 16 * 1024 * 1024,
  });
  if (run.error) throw run.error;
  const response = JSON.parse(run.status === 0 ? run.stdout : run.stderr);
  if (response.error?.type === "authorization" || response.error?.type === "authentication")
    throw new AuthorizationError();
  if (run.status !== 0 || response.ok !== true)
    throw new Error(`飞书读取失败：${response.error?.type ?? "未知错误"}，请在本机检查 CLI`);
  if (response.identity !== "user") throw new Error("飞书读取没有使用本人身份");
  return response.data;
}

const context = JSON.parse(readFileSync(process.env.AGENT_AUTOLOOP_CONTEXT!, "utf8"));
const blockedTitle = "请恢复飞书资料读取";
if (
  context.answers.length &&
  !context.answers.some(
    (answer: { title: string; choice: number | null }) => answer.title === blockedTitle && answer.choice === 0,
  )
) {
  console.log("没事可做：本轮未确认恢复，留待下次计划读取");
} else if (context.open.some((card: { title: string }) => card.title === blockedTitle) && !context.answers.length) {
  console.log("没事可做：等待本人恢复飞书读取");
} else {
  const sources: Sources = JSON.parse(readFileSync(process.argv[2], "utf8"));
  if (
    !sources.reportRule ||
    !sources.reportUsers.length ||
    sources.reportUsers.some((id) => !id.startsWith("ou_")) ||
    sources.tables.some((table) => !table.baseToken || !table.tableId || !table.fields.length || !table.name)
  ) {
    throw new Error("检查 sources.json：指定汇报规则、人员，以及表格和必要字段");
  }
  const folder = mkdtempSync(".brief-");
  try {
    const until = Math.floor(Date.now() / 1000);
    const from = until - 7 * 86_400;
    const reports: Report[] = [];
    for (const user of sources.reportUsers) {
      let page = "";
      do {
        const data = lark([
          "api",
          "POST",
          "/open-apis/report/v1/tasks/query",
          "--params",
          '{"user_id_type":"open_id"}',
          "--data",
          JSON.stringify({
            commit_start_time: from,
            commit_end_time: until,
            user_id: user,
            page_token: page,
            page_size: 20,
          }),
        ]);
        if (!Array.isArray(data.items)) throw new Error("飞书没有返回汇报列表，不能当作没有周报");
        reports.push(
          ...data.items.filter(
            (r: Report) =>
              r.from_user_id === user &&
              r.rule_name === sources.reportRule &&
              r.commit_time >= from &&
              r.commit_time <= until,
          ),
        );
        if (data.has_more && (!data.page_token || data.page_token === page))
          throw new Error("汇报分页标记无效，资料不完整");
        page = data.has_more ? data.page_token : "";
      } while (page);
    }
    const tables = [];
    for (const [index, table] of sources.tables.entries()) {
      const records = [];
      let offset = 0;
      let revision: string | number | undefined;
      for (;;) {
        const output = join(folder, `${index}-${offset}.ndjson`);
        lark([
          "base",
          "+record-list",
          "--base-token",
          table.baseToken,
          "--table-id",
          table.tableId,
          ...table.fields.flatMap((field) => ["--field-id", field]),
          "--offset",
          String(offset),
          "--limit",
          "2000",
          "--format",
          "ndjson",
          "--output",
          output,
        ]);
        const manifest = JSON.parse(readFileSync(output.replace(/\.ndjson$/, ".manifest.json"), "utf8"));
        if (offset && manifest.rev !== revision) throw new Error("读取期间表格版本改变，本次不生成摘要");
        revision = manifest.rev;
        records.push(
          ...readFileSync(output, "utf8")
            .split("\n")
            .filter(Boolean)
            .map((line) => JSON.parse(line)),
        );
        if (manifest.has_more === false) break;
        if (manifest.has_more !== true || !Number.isInteger(manifest.next_offset) || manifest.next_offset <= offset)
          throw new Error("表格分页信息无效，资料不完整");
        offset = manifest.next_offset;
      }
      tables.push({ name: table.name, url: table.url, fields: table.fields, records });
    }
    const content = {
      from: new Date(from * 1000).toISOString(),
      until: new Date(until * 1000).toISOString(),
      reports,
      tables,
    };
    const id = createHash("sha256").update(JSON.stringify(content)).digest("hex");
    writeFileSync("weekly-input.json.tmp", JSON.stringify({ id, ...content }, null, 2), { mode: 0o600 });
    renameSync("weekly-input.json.tmp", "weekly-input.json");
    console.log(
      `资料读取完成\n\n\`\`\`agent-autoloop\n${JSON.stringify({ events: [{ id, type: "brief.ready", subject: "weekly", summary: "本期飞书资料已完整读取" }] })}\n\`\`\``,
    );
  } catch (error) {
    if (!(error instanceof AuthorizationError)) throw error;
    console.log(
      `待你处理：请恢复飞书资料读取\n\n\`\`\`agent-autoloop\n${JSON.stringify({
        ask: [
          {
            key: "feishu-access",
            title: blockedTitle,
            text: "请在接单电脑恢复本人飞书登录或所需资料的访问权限，完成后选择继续。已有资料不会被当成本期结果。",
            options: ["已恢复，继续读取", "本期先跳过"],
            recommend: 0,
            about: "重新读取本期汇报和指定表格；完整成功后才交给摘要 Agent。",
          },
        ],
      })}\n\`\`\``,
    );
  } finally {
    rmSync(folder, { recursive: true, force: true });
  }
}
