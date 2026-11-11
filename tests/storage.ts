// Fixture resets only; production writes go through decide/commit/evolve.
import { fixtureClear } from "../host/runtime.ts";
import type { Table } from "../kernel/evolve.ts";
export { all, one } from "../host/runtime.ts";
export const run = (sql: string) => {
  const match = /^DELETE FROM (\w+)$/.exec(sql);
  if (!match) throw new Error(sql);
  fixtureClear(match[1] as Table);
};
