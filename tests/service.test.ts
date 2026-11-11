// Failure modes: systemd splits an install path at spaces, expands its `$` or `%`, or loads a different path after quotes
// and backslashes are parsed; a control character writes another directive into the generated service.
import assert from "node:assert/strict";
import { test } from "node:test";
import { unit } from "../host/service.ts";

const ordinary = {
  home: "/home/me/.agent-autoloop",
  executable: "/usr/bin/node",
  program: "/opt/agent-autoloop/bin/agent-autoloop.ts",
};

test("a systemd service keeps its existing structure and zero-argument use", () => {
  const service = unit(ordinary);
  assert.ok(service.includes("Description=Agent 自动化中台"));
  assert.ok(service.includes('Environment="AGENT_AUTOLOOP_HOME=/home/me/.agent-autoloop"'));
  assert.ok(
    service.includes(
      'ExecStart="/usr/bin/node" "--disable-warning=ExperimentalWarning" "/opt/agent-autoloop/bin/agent-autoloop.ts" "up"',
    ),
  );
  assert.ok(service.includes("Restart=always\nRestartSec=10"));
  assert.ok(service.includes("WantedBy=default.target"));
  assert.doesNotThrow(() => unit());
});

test("systemd receives spaces and special path characters literally", () => {
  const service = unit({
    home: String.raw`/home/用户/Agent Work/$cache%/say"hi"/back\slash`,
    executable: String.raw`/opt/Node $cache%/say"hi"/node`,
    program: String.raw`/opt/Agent Work/$repo%/back\slash/agent.ts`,
  });
  assert.ok(
    service.includes(
      String.raw`Environment="AGENT_AUTOLOOP_HOME=/home/用户/Agent Work/$cache%%/say\"hi\"/back\\slash"`,
    ),
  );
  assert.ok(
    service.includes(
      String.raw`ExecStart="/opt/Node $$cache%%/say\"hi\"/node" "--disable-warning=ExperimentalWarning" "/opt/Agent Work/$$repo%%/back\\slash/agent.ts" "up"`,
    ),
  );
});

test("systemd service values reject control characters", () => {
  for (const control of ["\0", "\t", "\n", "\r", "\u007f"]) {
    assert.throws(() => unit({ ...ordinary, home: `/home/me/before${control}after` }), /控制字符/);
  }
});
