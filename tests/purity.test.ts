// The architecture, as a test. The hub's kernel knows no vendor and makes no request of its own: everything connects to it.
// Failure cases: a product name, an outbound request, a runtime dependency or an interface enters the kernel.
import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";

const root = join(import.meta.dirname, "..");
const kernel = readdirSync(join(root, "kernel"))
  .filter((f) => f.endsWith(".ts"))
  .map((f) => [f, readFileSync(join(root, "kernel", f), "utf8")] as const);

test("the kernel names no product", () => {
  // Words in the two comments that say why a limit is what it is are the only exception: a limit has a reason.
  const vendors =
    /claude|anthropic|codex|openai|gemini|cursor|hermes|openclaw|feishu|lark|dingtalk|telegram|slack|github|gitlab/i;
  for (const [file, text] of kernel) {
    for (const [i, line] of text.split("\n").entries()) {
      if (line.trim().startsWith("//") || line.trim().startsWith("/**")) continue;
      assert.ok(!vendors.test(line), `${file}:${i + 1}: ${line.trim()}`);
    }
  }
});

test("the kernel makes no request of its own", () => {
  const requests =
    /\bfetch\(|https?\.request|https?\.get\(|node:https|node:net|node:dgram|node:tls|child_process|WebSocket/;
  for (const [file, text] of kernel) assert.ok(!requests.test(text), file);
});

test("nothing is installed to run it", () => {
  const manifest = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
  assert.deepEqual(manifest.dependencies ?? {}, {});
});

test("there's no interface in it", () => {
  assert.ok(!existsSync(join(root, "web")));
  for (const [file, text] of kernel) assert.ok(!/<script|cookie/i.test(text), file);
});

test("time and entropy enter through the shell", () => {
  for (const [file, text] of kernel)
    assert.ok(
      !/Date\.now\(|new Date\(\)|Math\.random\(|randomBytes|randomUUID|process\.env|node:fs|setTimeout|setInterval/.test(
        text,
      ),
      file,
    );
});

test("only evolve writes projections and only commit appends the log", () => {
  const production = ["kernel", "host", "protocol", "plugins", "worker", "cli"]
    .filter((name) => existsSync(join(root, name)))
    .flatMap((name) =>
      readdirSync(join(root, name), { recursive: true })
        .map(String)
        .filter((name) => name.endsWith(".ts"))
        .map((file) => `${name}/${file}`),
    );
  for (const file of production) {
    const text = readFileSync(join(root, file), "utf8");
    if (file !== "kernel/evolve.ts") assert.ok(!/\b(INSERT INTO|UPDATE|DELETE FROM) projections/.test(text), file);
    if (file !== "kernel/store.ts") assert.ok(!/\bINSERT INTO facts/.test(text), file);
    assert.ok(!/\b(UPDATE|DELETE FROM) facts/.test(text), file);
  }
  const store = readFileSync(join(root, "kernel/store.ts"), "utf8");
  assert.ok(!/INSERT INTO facts/.test(store.slice(0, store.indexOf("export function commit("))));
  assert.ok(readFileSync(join(root, "host/http.ts"), "utf8").split("\n").length <= 50);
});
