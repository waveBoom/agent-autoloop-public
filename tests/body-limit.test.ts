// Failure modes: a body declared far too large is read anyway, so a request nobody has checked yet holds a connection for
// nothing; a client told no is left on a connection that still expects the rest of its body, which breaks its next request.
import assert from "node:assert/strict";
import { once } from "node:events";
import { connect, type AddressInfo } from "node:net";
import { after, test } from "node:test";
import { setup } from "./helpers.ts";

setup("body-limit");
const hub = await import("../host/runtime.ts");
const { makeHandler } = await import("../host/server.ts");
const { serve } = await import("../host/http.ts");
const runtime = makeHandler();
after(runtime.close);
const key = hub.addKey("source", "app");
const MB = 1024 * 1024;

test("a body declared far too large isn't read at all", async () => {
  let read = 0;
  const body = new ReadableStream({
    pull(controller) {
      read += MB;
      controller.enqueue(new Uint8Array(MB));
    },
  });
  const answer = await runtime.handle(
    new Request("http://local/v1/events", {
      method: "POST",
      headers: { authorization: `Bearer ${key}`, "content-length": String(8 * MB + 1) },
      body,
      duplex: "half",
    } as RequestInit),
  );
  assert.equal(answer.status, 413);
  assert.ok(read <= MB, `read ${read} bytes`);
});

test("a refused request that never sent its body gets its answer and a closed connection", async () => {
  const server = serve(0);
  await once(server, "listening");
  const { port } = server.address() as AddressInfo;
  try {
    const socket = connect(port, "127.0.0.1");
    let said = "";
    socket.on("data", (chunk) => (said += chunk));
    socket.write(
      "POST /v1/events HTTP/1.1\r\nHost: local\r\n" +
        `Authorization: Bearer ${key}\r\nContent-Length: ${8 * MB + 1}\r\n\r\n`,
    );
    await once(socket, "close");
    assert.match(said, /^HTTP\/1\.1 413 /);
    assert.match(said, /connection: close/i);
  } finally {
    server.closeAllConnections();
    server.close();
  }
});
