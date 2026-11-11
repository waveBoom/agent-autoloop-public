// The smallest Agent plugin. `echo` stands in for a command-line Agent so this runs with no model and no account: put your
// CLI's print mode in its place, and read what that CLI really prints.
// In rules.json: "agents": { "hello": { "name": "Hello", "worker": "mac-mini", "use": "hello-agent" } }
type Turn = { prompt: string; session: string; resume: string | null; access: "read" | "edit" | "full" };

export default {
  command(turn: Turn) {
    const session = turn.resume ?? turn.session;
    const text = `收到了 ${turn.prompt.length} 字的提示词，权限 ${turn.access}。这是 hello-agent，什么也没做。`;
    return ["echo", JSON.stringify({ session, text })];
  },
  // Called while it runs too, with code null. A throw here stops the worker, so anything it can't read is an error it returns.
  // Once your CLI has taken the prompt, return started: true every time, even after it fails: a turn that broke then is
  // tried again in its session, while one that never got going carries on in a new session.
  read(stdout: string, code: number | null, stderr: string) {
    if (code === null) return {};
    if (code !== 0) return { error: stderr.trim() || `退出码 ${code}` };
    try {
      const { session, text } = JSON.parse(stdout);
      return { session, text };
    } catch {
      return { error: `读不懂它的输出：${stdout.slice(0, 200)}` };
    }
  },
  // With a link the worker reports the session as soon as the run starts, and can ask for a bad receipt to be rewritten.
  link: (session: string) => `hello-agent://sessions/${session}`,
};
