import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { createGateway, parseGatewayArgs } from "../src/server.js";

const fixture = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "fixtures", "echo-server.js");
const lifecycleFixture = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "fixtures", "lifecycle-server.js");

function createClient(port, name) {
  const client = new Client({ name, version: "0.0.1" });
  const transport = new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/mcp`));
  return { client, transport };
}

async function assertProcessExited(pid) {
  const deadline = Date.now() + 3000;
  while (Date.now() < deadline) {
    try {
      process.kill(pid, 0);
    } catch {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  assert.fail(`process ${pid} is still running`);
}

test("parseGatewayArgs reads command/args after --", () => {
  const parsed = parseGatewayArgs(["--port", "0", "--", "node", "server.js", "--flag"], {});
  assert.equal(parsed.command, "node");
  assert.deepEqual(parsed.args, ["server.js", "--flag"]);
  assert.equal(parsed.port, 0);
});

test("parseGatewayArgs falls back to environment variables", () => {
  const parsed = parseGatewayArgs([], { MAJIWARI_TARGET_COMMAND: "node", MAJIWARI_TARGET_ARGS: "a b", MAJIWARI_GATEWAY_PORT: "9999" });
  assert.equal(parsed.command, "node");
  assert.deepEqual(parsed.args, ["a", "b"]);
  assert.equal(parsed.port, 9999);
});

test("gateway forwards tool discovery and invocation unmodified", async () => {
  const gateway = await createGateway({ command: "node", args: [fixture], host: "127.0.0.1", port: 0 });
  try {
    const address = gateway.httpServer.address();
    const client = new Client({ name: "test-client", version: "0.0.1" });
    const transport = new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${address.port}/mcp`));
    await client.connect(transport);

    const { tools } = await client.listTools();
    assert.deepEqual(
      tools.map((t) => t.name),
      ["echo"]
    );
    assert.equal(tools[0].description, "Return the given text unchanged.");

    const result = await client.callTool({ name: "echo", arguments: { text: "hello" } });
    assert.deepEqual(result.content, [{ type: "text", text: "hello" }]);

    await client.close();
  } finally {
    await gateway.close();
  }
});

test("gateway isolates concurrent HTTP sessions", async () => {
  const gateway = await createGateway({ command: "node", args: [lifecycleFixture], host: "127.0.0.1", port: 0 });
  const port = gateway.httpServer.address().port;
  const connections = [createClient(port, "client-a"), createClient(port, "client-b")];
  let closed = false;
  try {
    await Promise.all(connections.map(({ client, transport }) => client.connect(transport)));
    const results = await Promise.all(
      connections.map(({ client }, index) => client.callTool({ name: "pid", arguments: { label: String.fromCharCode(97 + index) } }))
    );
    const values = results.map((result) => result.content[0].text);
    const pids = values.map((value) => Number(value.split(":", 1)[0]));

    assert.deepEqual(values.map((value) => value.split(":")[1]), ["a", "b"]);
    assert.notEqual(pids[0], pids[1]);
    assert.ok(pids.every((pid) => Number.isInteger(pid) && pid > 0));

    await Promise.all(connections.map(({ client }) => client.close()));
    await gateway.close();
    closed = true;
    await Promise.all(pids.map((pid) => assertProcessExited(pid)));
  } finally {
    await Promise.allSettled(connections.map(({ client }) => client.close()));
    if (!closed) await gateway.close();
  }
});

test("gateway cleans up a terminated session before reconnecting", async () => {
  const gateway = await createGateway({ command: "node", args: [lifecycleFixture], host: "127.0.0.1", port: 0 });
  const port = gateway.httpServer.address().port;
  const first = createClient(port, "first-client");
  const second = createClient(port, "second-client");
  let closed = false;
  try {
    await first.client.connect(first.transport);
    const firstPid = Number((await first.client.callTool({ name: "pid", arguments: { label: "first" } })).content[0].text.split(":", 1)[0]);
    const staleSessionId = first.transport.sessionId;
    assert.ok(staleSessionId);

    await first.transport.terminateSession();
    await assertProcessExited(firstPid);

    const staleResponse = await fetch(`http://127.0.0.1:${port}/mcp`, {
      method: "POST",
      headers: {
        accept: "application/json, text/event-stream",
        "content-type": "application/json",
        "mcp-protocol-version": "2025-06-18",
        "mcp-session-id": staleSessionId
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} })
    });
    assert.equal(staleResponse.status, 404);

    await second.client.connect(second.transport);
    const secondPid = Number((await second.client.callTool({ name: "pid", arguments: { label: "second" } })).content[0].text.split(":", 1)[0]);
    assert.notEqual(firstPid, secondPid);

    await second.transport.terminateSession();
    await assertProcessExited(secondPid);
    await gateway.close();
    closed = true;
  } finally {
    await Promise.allSettled([first.client.close(), second.client.close()]);
    if (!closed) await gateway.close();
  }
});
