// Failure modes: a listen address with no host becomes every interface (a local hub silently open to the network), a
// bare port becomes NaN and crashes startup, and an IPv6 address is split at the wrong colon.
import assert from "node:assert/strict";
import { test } from "node:test";
import { parseListen } from "../host/config.ts";

test("a listen address is a host and a port, strictly", () => {
  assert.deepEqual(parseListen("127.0.0.1:3350"), { host: "127.0.0.1", port: 3350 });
  assert.deepEqual(parseListen("[::1]:3350"), { host: "::1", port: 3350 });
  assert.deepEqual(parseListen("10.0.0.5:80"), { host: "10.0.0.5", port: 80 });
  for (const wrong of [
    ":3350",
    "3350",
    "127.0.0.1:",
    "127.0.0.1:0",
    "127.0.0.1:65536",
    "127.0.0.1:http",
    "127.0.0.1:3350:extra",
    " :3350",
  ]) {
    assert.throws(() => parseListen(wrong), Error, wrong);
  }
});
