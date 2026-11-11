// A turn run over the Agent Client Protocol: a process of its own that talks to the ACP agent on stdio and prints what
// the worker's adapter reads, one JSON object per line.
import { spawn } from "node:child_process";
import { existsSync, realpathSync } from "node:fs";
import { basename, dirname, isAbsolute, relative, resolve } from "node:path";
import { createInterface } from "node:readline";
import { versionName } from "../../host/version.ts";
import type { Turn } from "../../worker/agents.ts";

function resolved(file: string): string {
  if (existsSync(file)) return realpathSync(file);
  return resolve(resolved(dirname(file)), basename(file));
}

export function permission(turn: Pick<Turn, "access" | "cwd">, params: any) {
  const tool = params.toolCall ?? {};
  const inside = (location: any) => {
    if (typeof location.path !== "string" || !isAbsolute(location.path)) return false;
    const path = relative(realpathSync(turn.cwd), resolved(location.path));
    return path !== ".." && !path.startsWith("../") && !isAbsolute(path);
  };
  const editsInside =
    turn.access === "edit" && tool.kind === "edit" && tool.locations?.length > 0 && tool.locations.every(inside);
  const allowed = turn.access === "full" || tool.kind === "read" || tool.kind === "search" || editsInside;
  const option = params.options?.find((option: any) => option.kind === (allowed ? "allow_once" : "reject_once"));
  return option ? { outcome: "selected", optionId: option.optionId } : { outcome: "cancelled" };
}

export async function bridge(turn: Turn) {
  if (!turn.command?.length) throw new Error("ACP 要在 command 写启动命令");
  const child = spawn(turn.command[0], turn.command.slice(1), { cwd: turn.cwd, stdio: ["pipe", "pipe", "inherit"] });
  const pending = new Map<number, { resolve: (value: any) => void; reject: (error: Error) => void }>();
  let next = 0;
  let session = "";
  let collecting = false;
  let text = "";
  let message: string | undefined;
  let boundary = false;
  const send = (body: object) => child.stdin.write(JSON.stringify({ jsonrpc: "2.0", ...body }) + "\n");
  const fail = (error: Error) => {
    for (const request of pending.values()) request.reject(error);
    pending.clear();
  };
  child.on("error", fail);
  child.on("exit", (code) => fail(new Error(`ACP 在交回结果前退出：${code}`)));
  child.stdin.on("error", fail);

  const onUpdate = (update: any) => {
    if (update.sessionUpdate === "agent_message_chunk" && update.content?.type === "text") {
      if (boundary || (update.messageId && update.messageId !== message)) text = "";
      message = update.messageId;
      boundary = false;
      text += update.content.text;
    } else if (["tool_call", "agent_thought_chunk", "user_message_chunk"].includes(update.sessionUpdate)) {
      boundary = true;
    }
  };
  const onLine = (line: string) => {
    const incoming = JSON.parse(line);
    if (incoming.method === "session/update" && collecting && incoming.params?.sessionId === session) {
      onUpdate(incoming.params.update);
    } else if (incoming.method && incoming.id !== undefined) {
      const { id, method, params } = incoming;
      if (method === "session/request_permission" && params?.sessionId === session) {
        send({ id, result: { outcome: permission(turn, params) } });
      } else send({ id, error: { code: -32601, message: "不支持这个方法" } });
    } else if (pending.has(incoming.id)) {
      const request = pending.get(incoming.id)!;
      pending.delete(incoming.id);
      if (incoming.error) request.reject(new Error(incoming.error.message));
      else request.resolve(incoming.result);
    }
  };
  const lines = createInterface({ input: child.stdout });
  lines.on("line", (line) => {
    try {
      onLine(line);
    } catch (error) {
      fail(error as Error);
    }
  });

  const rpc = (method: string, params: object) =>
    new Promise<any>((resolve, reject) => {
      const id = ++next;
      pending.set(id, { resolve, reject });
      send({ id, method, params });
    });
  const stop = () => child.kill("SIGTERM");
  process.on("SIGTERM", stop);
  try {
    const clientInfo = { name: "agent-autoloop", version: versionName() };
    const init = await rpc("initialize", { protocolVersion: 1, clientCapabilities: {}, clientInfo });
    if (init.protocolVersion !== 1) throw new Error(`不支持 ACP 版本 ${init.protocolVersion}`);
    if (turn.resume) {
      if (!init.agentCapabilities?.loadSession) throw new Error("这个 ACP Agent 不支持恢复会话");
      session = turn.resume;
      await rpc("session/load", { sessionId: session, cwd: turn.cwd, mcpServers: [] });
    } else session = (await rpc("session/new", { cwd: turn.cwd, mcpServers: [] })).sessionId;
    if (typeof session !== "string" || !session) throw new Error("ACP 没有返回会话编号");
    // Before the prompt goes: the agent can start on it at once, and this has to be there if the bridge is killed then.
    console.log(JSON.stringify({ session, started: true }));
    collecting = true;
    const prompt = [{ type: "text", text: turn.prompt }];
    const result = await rpc("session/prompt", { sessionId: session, prompt });
    if (result.stopReason !== "end_turn" || !text.trim()) throw new Error(`ACP 没有完成这一轮：${result.stopReason}`);
    console.log(JSON.stringify({ session, text, finished: true }));
  } finally {
    process.removeListener("SIGTERM", stop);
    lines.close();
    child.stdin.end();
    child.kill("SIGTERM");
  }
}

if (import.meta.main) {
  bridge(JSON.parse(process.argv[2])).catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
