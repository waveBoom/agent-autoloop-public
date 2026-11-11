import assert from "node:assert/strict";
import { fork } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { decide } from "../kernel/decide.ts";
import { empty, evolve, rows, snapshot } from "../kernel/evolve.ts";
import { commit, readLog, rebuild, openView } from "../kernel/store.ts";
import { rules, environment } from "./world.ts";
import { random } from "./random.ts";
import { invariants } from "./invariants.ts";

function database(file: string) {
  const db = new DatabaseSync(file);
  db.exec(
    "PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; CREATE TABLE IF NOT EXISTS facts(seq INTEGER PRIMARY KEY,fact TEXT); CREATE TABLE IF NOT EXISTS projections(collection TEXT,key TEXT,data TEXT,PRIMARY KEY(collection,key));",
  );
  return db;
}
async function child(file: string) {
  const db = database(file);
  let view = openView(db, "");
  let n = 0;
  const act = (type: string, ...args: any[]) => {
    let d: ReturnType<typeof decide>;
    view = commit(db, view, () => {
      d = decide(view, { type, args }, n, environment);
      return d.facts;
    });
    process.send!({ seq: view.seq });
    return d!.value;
  };
  act("rules", rules);
  process.send!({ ready: true });
  for (;;) {
    n++;
    act("ingest", "app", { id: String(n), type: "one", subject: `#${n}` });
    const job = act("claimNext", "w1", `claim-${n}`);
    act("finish", job.run, job.token, {
      outcome: "done",
      notice: [{ title: "完成", text: String(n), key: String(n) }],
    });
    await new Promise((resolve) => setImmediate(resolve));
  }
}
export async function crashCheck(count = 1000, seed = 0xc0ffee) {
  const rng = random(seed);
  const directory = mkdtempSync(join(tmpdir(), "agent-autoloop-crash-"));
  let acknowledged = 0;
  let unacknowledged = 0;
  let kills = 0;
  try {
    for (let i = 0; i < count; i++) {
      const file = join(directory, `${i}.db`);
      const acks = new Set<number>();
      let timer: NodeJS.Timeout | undefined;
      let err = "";
      const proc = fork(import.meta.filename, ["child", file], {
        execArgv: ["--disable-warning=ExperimentalWarning"],
        stdio: ["ignore", "ignore", "pipe", "ipc"],
        env: { ...process.env, AGENT_AUTOLOOP_HOME: directory },
      });
      proc.stderr!.on("data", (b) => {
        err += b;
      });
      try {
        const signal = await new Promise<NodeJS.Signals | null>((resolve, reject) => {
          proc.on("error", reject);
          proc.on("close", (_code, signal) => resolve(signal));
          proc.on("message", (m: any) => {
            if (m.seq) acks.add(m.seq);
            if (m.ready) timer = setTimeout(() => proc.kill("SIGKILL"), 1 + rng(10));
          });
        });
        assert.equal(signal, "SIGKILL", err);
        kills++;
      } finally {
        clearTimeout(timer);
        if (proc.exitCode === null && proc.signalCode === null) proc.kill("SIGKILL");
      }
      const db = database(file);
      try {
        assert.equal(db.prepare("PRAGMA integrity_check").get()!.integrity_check, "ok");
        const log = readLog(db);
        let view = evolve(empty(), log);
        for (const seq of acks)
          assert.ok(
            log.some((f) => f.seq === seq),
            `确认过的事实丢了：${i}/${seq}`,
          );
        acknowledged += acks.size;
        unacknowledged += log.filter((f) => !acks.has(f.seq)).length;
        invariants(view, log);
        const expected = snapshot(view);
        const persisted = db.prepare("SELECT collection,key,data FROM projections").all();
        assert.equal(
          persisted.length,
          Object.values(expected.tables).reduce((n, table) => n + Object.keys(table).length, 0),
        );
        for (const r of persisted)
          assert.deepEqual(
            JSON.parse(String(r.data)),
            expected.tables[r.collection as keyof typeof expected.tables][String(r.key)],
          );
        assert.deepEqual(snapshot(openView(db, "")), expected);
        assert.deepEqual(snapshot(rebuild(db)), expected);
        for (const event of rows(view, "events")) {
          const d = decide(
            view,
            { type: "ingest", args: ["app", { id: event.key, type: "one", subject: event.subject }] },
            1000,
            environment,
          );
          assert.equal(d.value.duplicate, true);
          assert.equal(d.value.event, event.id);
          assert.equal(d.facts.length, 0);
        }
        view.close();
      } finally {
        db.close();
        for (const suffix of ["", "-wal", "-shm"]) rmSync(file + suffix, { force: true });
      }
      if (count >= 100 && kills % 100 === 0) console.log(`已完成 ${kills}/${count} 次 SIGKILL`);
    }
    return { seed, kills, acknowledged, unacknowledged };
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}
if (import.meta.main) {
  if (process.argv[2] === "child") await child(process.argv[3]);
  else
    console.log(
      JSON.stringify(await crashCheck(Number(process.argv[2] ?? 1000), Number(process.argv[3] ?? 0xc0ffee)), null, 2),
    );
}
