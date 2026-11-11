// Failure modes: loading history becomes this turn's answer; a restarted bridge forgets the agent's session; thought/tool
// output becomes a receipt; unknown permissions are approved; paths escape through symlinks; an RPC error looks successful;
// a turn the agent took and then lost isn't marked as started, so the worker runs its prompt again; a session that couldn't
// be loaded is marked as started, so the worker never starts a new one; an agent is told a version number left behind by a
// release.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync, rmSync, mkdirSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import acp from "../plugins/acp/agent.ts";
import { permission } from "../plugins/acp/bridge.ts";
import { versionName } from "../host/version.ts";
const home = mkdtempSync(join(tmpdir(), "agent-autoloop-acp-"));
after(() => rmSync(home, { recursive: true, force: true }));
const fake = join(home, "fake.mjs");
writeFileSync(
  fake,
  `
import readline from 'node:readline';
import { writeFileSync } from 'node:fs';
const send=x=>process.stdout.write(JSON.stringify({jsonrpc:'2.0',...x})+'\\n');
const update=(sessionUpdate,text)=>send({method:'session/update',params:{sessionId:'agent-session',update:{sessionUpdate,content:{type:'text',text}}}});
readline.createInterface({input:process.stdin}).on('line',line=>{const m=JSON.parse(line);if(m.id===undefined)return;
if(m.method==='initialize'){writeFileSync(${JSON.stringify(join(home, "client-version"))},m.params.clientInfo.version);send({id:m.id,result:{protocolVersion:1,agentCapabilities:{loadSession:true}}});}
if(m.method==='session/new')send({id:m.id,result:{sessionId:'agent-session'}});
if(m.method==='session/load'){if(m.params.sessionId!=='agent-session')return send({id:m.id,error:{code:-1,message:'bad session'}});update('agent_message_chunk','旧历史');send({id:m.id,result:{}});}
if(m.method==='session/prompt'){if(m.params.prompt[0].text==='中途断了'){update('tool_call','');process.exit(9);}update('agent_thought_chunk','思考');update('agent_message_chunk','中间消息');update('tool_call','');update('agent_message_chunk',m.params.prompt[0].text);send({id:m.id,result:{stopReason:'end_turn'}});}
});`,
);
const run = (resume: string | null, prompt = "完成了") =>
  new Promise<{ code: number | null; out: string; err: string }>((resolve) => {
    const child = spawn(
      process.execPath,
      [
        "--disable-warning=ExperimentalWarning",
        join(import.meta.dirname, "../plugins/acp/bridge.ts"),
        JSON.stringify({ command: [process.execPath, fake], cwd: home, prompt, access: "read", resume }),
      ],
      { stdio: ["ignore", "pipe", "pipe"] },
    );
    let out = "";
    let err = "";
    child.stdout.on("data", (b) => (out += b));
    child.stderr.on("data", (b) => (err += b));
    child.on("close", (code) => resolve({ code, out, err }));
  });
test("ACP speaks v1, resumes across processes, discards history and returns only the final answer", async () => {
  for (const resume of [null, "agent-session"]) {
    const r = await run(resume);
    assert.equal(r.code, 0, r.err);
    const lines = r.out
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l));
    assert.equal(lines.at(-1).text, "完成了");
    assert.equal(lines.at(-1).session, "agent-session");
    assert.ok(!r.out.includes("旧历史"));
    assert.ok(!r.out.includes("思考"));
  }
  const bad = await run("missing-session");
  assert.notEqual(bad.code, 0);
  assert.match(bad.err, /bad session/);
});
test("ACP says a turn started once the agent has the prompt, and never for a session it couldn't load", async () => {
  for (const resume of [null, "agent-session"]) {
    const ok = await run(resume);
    assert.equal(
      JSON.parse(ok.out.split("\n")[0]).started,
      true,
      "printed before the prompt goes, so it survives a kill",
    );
    assert.equal(acp.read(ok.out, null, "").started, true);
    assert.equal(acp.read(ok.out, ok.code, ok.err).text, "完成了");
    const lost = await run(resume, "中途断了");
    assert.notEqual(lost.code, 0);
    const reading = acp.read(lost.out, lost.code, lost.err);
    assert.deepEqual(
      [reading.started, reading.session, reading.text],
      [true, "agent-session", undefined],
      "a broken turn keeps its session and doesn't count as an answer",
    );
    assert.match(reading.error!, /ACP/);
  }
  const missing = await run("missing-session");
  const reading = acp.read(missing.out, missing.code, missing.err);
  assert.equal(reading.started, undefined);
  assert.match(reading.error!, /bad session/);
});
test("ACP chooses only a one-time permission and respects structured kinds and resolved paths", () => {
  const options = [
    { optionId: "always", kind: "allow_always" },
    { optionId: "once", kind: "allow_once" },
    { optionId: "no", kind: "reject_once" },
  ];
  const ask = (access: string, toolCall: any) => permission({ access, cwd: home } as any, { options, toolCall });
  assert.equal(ask("read", { kind: "read" }).outcome, "selected");
  assert.equal(ask("read", { kind: "execute", title: "read file" }).optionId, "no");
  assert.equal(ask("edit", { kind: "edit", locations: [{ path: join(home, "new.txt") }] }).optionId, "once");
  mkdirSync(join(home, "work"));
  symlinkSync(tmpdir(), join(home, "work", "escape"));
  assert.equal(
    ask("edit", { kind: "edit", locations: [{ path: join(home, "work", "escape", "outside") }] }).optionId,
    "no",
  );
  assert.equal(ask("edit", { kind: "other" }).optionId, "no");
  assert.equal(ask("full", { kind: "other" }).optionId, "once");
});
test("ACP refuses incompatible versions and premature process exit", async () => {
  const original = await import("node:fs").then((fs) => fs.readFileSync(fake, "utf8"));
  try {
    writeFileSync(fake, original.replace("protocolVersion:1", "protocolVersion:99"));
    assert.notEqual((await run(null)).code, 0);
    writeFileSync(fake, "process.exit(0)");
    assert.notEqual((await run(null)).code, 0);
  } finally {
    writeFileSync(fake, original);
  }
});

test("the agent is told which version this is", async () => {
  await run(null);
  assert.equal(readFileSync(join(home, "client-version"), "utf8"), versionName());
});
