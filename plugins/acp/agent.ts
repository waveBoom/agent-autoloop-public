import { join } from "node:path";
import { tail, type Adapter, type Reading } from "../../worker/agents.ts";

export default {
  command: (turn) => [
    process.execPath,
    "--disable-warning=ExperimentalWarning",
    join(import.meta.dirname, "bridge.ts"),
    JSON.stringify(turn),
  ],
  read(stdout, code, stderr) {
    let reading: Reading = {};
    for (const line of stdout.trim().split("\n")) {
      try {
        reading = { ...reading, ...JSON.parse(line) };
      } catch {
        /* A partial final line is read again after the next poll. */
      }
    }
    if (code !== null && (code !== 0 || !reading.finished)) {
      return { session: reading.session, started: reading.started, error: tail(stderr) || "ACP 没有完成这一轮" };
    }
    return reading;
  },
} satisfies Adapter;
