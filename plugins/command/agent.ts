// Anything with a print mode: its command line in rules.json, its last message on stdout. A script is an agent too, and
// a plain command needn't take the prompt at all: it finds what it needs through the environment (AGENT_AUTOLOOP_CONTEXT).
import { tail, type Adapter } from "../../worker/agents.ts";

export default {
  command: (turn) =>
    (turn.command ?? []).map((part) =>
      part
        .replaceAll("{prompt}", turn.prompt)
        .replaceAll("{model}", turn.model ?? "")
        .replaceAll("{effort}", turn.effort ?? "")
        .replaceAll("{cwd}", turn.cwd)
        .replaceAll("{context}", turn.contextFile),
    ),
  read(stdout, code, stderr) {
    if (code === null) return {};
    if (code !== 0) return { error: `退出码 ${code}：${tail(stderr || stdout) || "没留下原因"}` };
    return { text: stdout };
  },
} satisfies Adapter;
