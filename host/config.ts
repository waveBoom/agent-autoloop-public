// What this machine is in the system: config.json, private to its owner. On a machine that runs everything it has all
// of these; a machine that only does work has the hub's address and a worker's key.
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";
import { HOME } from "./home.ts";

export type ChannelConfig = { use?: string; key: string; [option: string]: unknown };
export type Config = {
  url: string;
  hub?: { listen: string; publicUrl?: string };
  worker?: { name: string; key: string; capacity?: number; unreachable?: string[] };
  channels?: Record<string, ChannelConfig>;
  source?: { name: string; key: string };
  owner?: string;
};

export const CONFIG_FILE = path.join(HOME, "config.json");

/** The hub's address: host:port, or [host]:port for an IPv6 address. A bare port is a mistake, not every interface. */
export function parseListen(listen: string) {
  const match = /^\[([0-9a-fA-F:.]+)\]:([0-9]+)$/.exec(listen) ?? /^([^:\s]+):([0-9]+)$/.exec(listen);
  if (!match) throw new Error(`hub.listen 要写成 主机:端口（IPv6 用 [地址]:端口）：${listen}`);
  const port = Number(match[2]);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`hub.listen 的端口要在 1 到 65535 之间：${listen}`);
  }
  return { host: match[1], port };
}

export function readConfig(): Config {
  if (!existsSync(CONFIG_FILE)) throw new Error("还没装好：先运行 agent-autoloop init");
  return JSON.parse(readFileSync(CONFIG_FILE, "utf8")) as Config;
}

export function writeConfig(config: Config) {
  mkdirSync(HOME, { recursive: true, mode: 0o700 });
  writeFileSync(`${CONFIG_FILE}.tmp`, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
  renameSync(`${CONFIG_FILE}.tmp`, CONFIG_FILE);
}
