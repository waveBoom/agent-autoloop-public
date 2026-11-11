import { globSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { zstdDecompressSync } from "node:zlib";

type Message = { role: "user" | "assistant"; text: string };

export function codexHistory(sessions: string[]) {
  const cwd = process.env.CODEX_HOME || path.join(homedir(), ".codex");
  return sessions.map((id) => {
    const messages: Message[] = [];
    if (!/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(id)) return { id, status: "missing", messages };
    try {
      const pattern = `rollout-*-${id}.jsonl`;
      const file = globSync(
        [
          `sessions/**/${pattern}`,
          `archived_sessions/${pattern}`,
          `sessions/**/${pattern}.zst`,
          `archived_sessions/${pattern}.zst`,
        ],
        { cwd },
      )[0];
      if (!file) return { id, status: "missing", messages };
      const data = readFileSync(path.join(cwd, file));
      const lines = (file.endsWith(".zst") ? zstdDecompressSync(data) : data).toString("utf8").trimEnd().split("\n");
      const meta = JSON.parse(lines[0]);
      if (meta.type !== "session_meta" || meta.payload?.id !== id) return { id, status: "missing", messages };
      let incomplete = false;
      for (const line of lines.slice(1)) {
        if (!line.trim()) continue;
        try {
          const { type, payload } = JSON.parse(line);
          if (type !== "response_item" || payload?.type !== "message") continue;
          const { role, content } = payload;
          if ((role !== "user" && role !== "assistant") || !Array.isArray(content)) continue;
          const text = content
            .map((part) => (typeof part?.text === "string" ? part.text : ""))
            .filter(Boolean)
            .join("\n");
          if (text) messages.push({ role, text });
        } catch {
          incomplete = true;
        }
      }
      return { id, status: incomplete ? "incomplete" : messages.length ? "available" : "missing", messages };
    } catch {
      return { id, status: "unreadable", messages };
    }
  });
}
