import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { createGateway, parseGatewayArgs } from "../src/server.js";

const fixture = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "fixtures", "echo-server.js");

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
