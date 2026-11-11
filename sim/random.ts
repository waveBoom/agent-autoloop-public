import assert from "node:assert/strict";
import { performance } from "node:perf_hooks";
import { rows } from "../kernel/evolve.ts";
import { AuthError } from "../kernel/errors.ts";
import { credential } from "../kernel/credentials.ts";
import { World, environment } from "./world.ts";

export function random(seed: number) {
  let state = seed >>> 0;
  return (n: number) => {
    state = (state + 0x6d2b79f5) | 0;
    let t = Math.imul(state ^ (state >>> 15), state | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return Math.floor((((t ^ (t >>> 14)) >>> 0) / 4294967296) * n);
  };
}
export function simulate(seed = 0x5eed, steps = 200000) {
  const rng = random(seed);
  const start = performance.now();
  const faults: Record<string, number> = { lost: 0, duplicate: 0, restart: 0, offline: 0, channel: 0, clock: 0 };
  let world = new World();
  let completed = 0;
  const receipts: { id: number; token: string; body: object; ack: object }[] = [];
  for (let step = 0; step < steps; step++) {
    try {
      if (step && step % 128 === 0) {
        completed += world.recover();
        world.view.close();
        world = new World();
        receipts.length = 0;
      }
      world.advance(rng(30000));
      const op = rng(12);
      const live = rows(world.view, "runs").filter((r) => ["claimed", "unknown"].includes(r.state));
      if (op < 3) {
        const id = String(rng(16));
        const args = ["app", { id, type: rng(2) ? "one" : "two", subject: `#${rng(4)}` }];
        world.call("ingest", ...args);
        if (op === 0) {
          faults.duplicate++;
          assert.equal(world.call("ingest", ...args).duplicate, true);
        }
      } else if (op === 3 || op === 4) {
        const worker = rng(2) ? "w1" : "w2";
        const claim = `claim-${rng(4)}`;
        world.call(
          "heartbeat",
          worker,
          live.filter((r) => r.agent === (worker === "w1" ? "a" : "b") && rng(3) !== 0).map((r) => r.id),
        );
        world.alarm();
        const job = world.call("claimNext", worker, claim);
        if (op === 4 && job) {
          faults.lost++;
          const again = world.call("claimNext", worker, claim);
          assert.equal(again.run, job.run);
        }
      } else if (op === 5 && live.length) {
        const r = live[rng(live.length)];
        const fail = rng(4) === 0;
        const body = {
          outcome: fail ? "failed" : "done",
          ...(!fail && rng(4) === 0
            ? {
                ask: [{ title: "选择", text: "内容", options: ["甲", "乙"], key: `card-${r.id}` }],
                later: [{ key: `timer-${r.id}`, at: new Date(world.now + 60000).toISOString(), about: "复查" }],
              }
            : {}),
        };
        const token = credential(environment, "run", r.id, r.issued);
        const ack = world.call("finish", r.id, token, body);
        receipts.push({ id: r.id, token, body, ack });
      } else if (op === 6 && receipts.length) {
        faults.lost++;
        const r = receipts[rng(receipts.length)];
        const current = world.view.get("runs", r.id);
        const valid =
          current?.last_issued !== null &&
          current &&
          credential(environment, "run", r.id, current.last_issued) === r.token;
        if (valid) assert.deepEqual(world.call("finish", r.id, r.token, r.body), { ...r.ack, duplicate: true });
        else assert.throws(() => world.call("finish", r.id, r.token, r.body), AuthError);
      } else if (op === 7) {
        faults.restart++;
        world.restart();
      } else if (op === 8) {
        faults.offline++;
        world.advance(700000);
      } else if (op === 9) {
        faults.channel++;
        const card = world.call("nextCard", "chat");
        if (card) {
          if (rng(2)) world.call("failed", "chat", card.id, card.version, "模拟断线");
          else {
            world.call("delivered", "chat", card.id, card.version, `message-${card.id}`);
            if (card.state === "open")
              world.call("answer", card.id, { choice: 0, by: "owner", channel: "chat", ref: `message-${card.id}` });
          }
        }
      } else if (op === 10) {
        faults.clock++;
        world.advance(-rng(120000));
      } else {
        const card = rows(world.view, "cards").find((c) => c.kind === "ask");
        if (card) {
          world.call("answer", card.id, { choice: rng(2) });
          world.call("answer", card.id, { choice: rng(2) });
        } else world.alarm();
      }
    } catch (error) {
      throw new Error(`种子 ${seed}，第 ${step} 步；node sim/random.ts ${seed} ${step + 1}`, { cause: error });
    }
  }
  completed += world.recover();
  world.view.close();
  const ms = performance.now() - start;
  return { seed, steps, epoch: 128, faults, completed, ms, stepsPerSecond: Math.round((steps * 1000) / ms) };
}
if (import.meta.main)
  console.log(JSON.stringify(simulate(Number(process.argv[2] ?? 0x5eed), Number(process.argv[3] ?? 200000)), null, 2));
