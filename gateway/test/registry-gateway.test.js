import test from "node:test";
import assert from "node:assert/strict";
import net from "node:net";
import { fileURLToPath } from "node:url";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { AdapterRegistry, AdapterState } from "@majiwari/registry";
import { ADAPTER_ID_HEADER, createRegistryGateway } from "../src/registry-gateway.js";
import { createStdioGatewayTransport } from "../src/stdio-target.js";

const PROBE_SERVER = fileURLToPath(new URL("./fixtures/probe-server.mjs", import.meta.url));

function getFreePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
  });
}

function probeManifest(id) {
  return {
    schemaVersion: "1",
    id,
    version: "1.0.0",
    transport: createStdioGatewayTransport({ command: process.execPath, args: [PROBE_SERVER, id] })
  };
}

async function startGateway() {
  const registry = new AdapterRegistry();
  const port = await getFreePort();
  const gateway = await createRegistryGateway({ registry, host: "127.0.0.1", port });
  return { gateway, port, registry };
}

async function connectClient(port, adapterId) {
  const client = new Client({ name: `test-${adapterId}`, version: "1.0.0" }, { capabilities: {} });
  const transport = new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/mcp`), {
    requestInit: { headers: { [ADAPTER_ID_HEADER]: adapterId } }
  });
  await client.connect(transport);
  return client;
}

function probeResult(result) {
  return JSON.parse(result.content[0].text);
}

test("publish() starts the adapter's own resource and marks it running", async () => {
  const { gateway, registry } = await startGateway();
  try {
    const started = await gateway.publish(probeManifest("fixture-a"));
    assert.equal(started.state, AdapterState.RUNNING);
    assert.equal(registry.get("fixture-a").state, AdapterState.RUNNING);
    assert.ok(registry.resource("fixture-a").client);
  } finally {
    await gateway.close();
  }
});

test("gateway publishes two fixture adapters concurrently and routes each client deterministically by adapter id", async () => {
  const { gateway, port } = await startGateway();
  let clientA;
  let clientB;
  try {
    await gateway.publish(probeManifest("fixture-a"));
    await gateway.publish(probeManifest("fixture-b"));

    clientA = await connectClient(port, "fixture-a");
    clientB = await connectClient(port, "fixture-b");

    const toolsA = await clientA.listTools();
    const toolsB = await clientB.listTools();
    assert.deepEqual(toolsA.tools.map((tool) => tool.name), ["fixture-a_probe"]);
    assert.deepEqual(toolsB.tools.map((tool) => tool.name), ["fixture-b_probe"]);

    const resultA = probeResult(await clientA.callTool({ name: "fixture-a_probe" }));
    const resultB = probeResult(await clientB.callTool({ name: "fixture-b_probe" }));

    // Each adapter answered as itself, from its own process -- no response
    // or session cross-routing between the two concurrently published
    // adapters and their two independent clients.
    assert.equal(resultA.adapterId, "fixture-a");
    assert.equal(resultB.adapterId, "fixture-b");
    assert.notEqual(resultA.pid, resultB.pid);

    // A client bound to fixture-a can never reach fixture-b's tool, even by
    // name -- the session was bridged onto fixture-a's client only.
    await assert.rejects(() => clientA.callTool({ name: "fixture-b_probe" }));
  } finally {
    await clientA?.close();
    await clientB?.close();
    await gateway.close();
  }
});

test("an unknown or unpublished adapter id is rejected before any session is created", async () => {
  const { gateway, port } = await startGateway();
  try {
    await gateway.publish(probeManifest("fixture-a"));
    await assert.rejects(() => connectClient(port, "does-not-exist"));
  } finally {
    await gateway.close();
  }
});

test("unpublish() cleans up only the removed adapter's own sessions and process, leaving siblings untouched", async () => {
  const { gateway, port, registry } = await startGateway();
  let clientA;
  let clientB;
  try {
    await gateway.publish(probeManifest("fixture-a"));
    await gateway.publish(probeManifest("fixture-b"));

    clientA = await connectClient(port, "fixture-a");
    clientB = await connectClient(port, "fixture-b");

    await gateway.unpublish("fixture-a");

    assert.equal(registry.get("fixture-a").state, AdapterState.STOPPED);
    // fixture-a's session is gone: any further call on it fails.
    await assert.rejects(() => clientA.listTools());

    // fixture-b was never asked to stop and keeps serving its own session.
    assert.equal(registry.get("fixture-b").state, AdapterState.RUNNING);
    const toolsB = await clientB.listTools();
    assert.deepEqual(toolsB.tools.map((tool) => tool.name), ["fixture-b_probe"]);
    const resultB = probeResult(await clientB.callTool({ name: "fixture-b_probe" }));
    assert.equal(resultB.adapterId, "fixture-b");
  } finally {
    await clientB?.close();
    await gateway.close();
  }
});
