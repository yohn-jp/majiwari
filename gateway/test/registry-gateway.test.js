import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { AdapterRegistry, AdapterState, UnknownAdapterError } from "@majiwari/registry";
import { GatewayAttachError, createRegistryGateway } from "../src/registry-gateway.js";
import { createStdioGatewayTransport } from "../src/stdio-target.js";

const PROBE_SERVER = fileURLToPath(new URL("./fixtures/probe-server.mjs", import.meta.url));
const HANGING_SERVER = fileURLToPath(new URL("./fixtures/hanging-server.mjs", import.meta.url));

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

function probeManifest(id, overrides = {}) {
  return {
    schemaVersion: "1",
    id,
    version: "1.0.0",
    transport: createStdioGatewayTransport({ command: process.execPath, args: [PROBE_SERVER, id] }),
    ...overrides
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
  const transport = new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/mcp/${adapterId}`));
  await client.connect(transport);
  return client;
}

function probeResult(result) {
  return JSON.parse(result.content[0].text);
}

/**
 * A raw GET straight to the routing server's own path, bypassing the MCP
 * client/transport entirely -- `http.request()`'s `path` option is sent
 * verbatim on the wire without validating or re-encoding it, so this is the
 * one way to actually put a malformed percent-encoded, path-shaped, or
 * otherwise out-of-charset id on the request line, the way a raw client
 * (not necessarily this repo's own SDK-based client) could.
 */
function rawGet(port, rawPath) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: "127.0.0.1", method: "GET", path: rawPath, port }, (res) => {
      res.resume();
      res.on("end", () => resolve(res.statusCode));
    });
    req.on("error", reject);
    req.end();
  });
}

async function waitFor(predicate, { timeoutMs = 5000, intervalMs = 20 } = {}) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await predicate();
    if (value) return value;
    if (Date.now() > deadline) throw new Error("waitFor: timed out");
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
}

function isProcessAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

test("publish() starts the adapter's own resource and marks it running", async () => {
  const { gateway, registry } = await startGateway();
  try {
    const started = await gateway.publish(probeManifest("fixture-a"));
    assert.equal(started.state, AdapterState.RUNNING);
    assert.equal(registry.get("fixture-a").state, AdapterState.RUNNING);
    assert.ok(registry.resource("fixture-a").mcpClient);
  } finally {
    await gateway.close();
  }
});

test("gateway publishes two fixture adapters concurrently at /mcp/:adapterId and routes each client deterministically by path", async () => {
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

    // A client bound to /mcp/fixture-a can never reach fixture-b's tool,
    // even by name -- the session was bridged onto fixture-a's own internal
    // bridge and upstream client only.
    await assert.rejects(() => clientA.callTool({ name: "fixture-b_probe" }));
  } finally {
    await clientA?.close();
    await clientB?.close();
    await gateway.close();
  }
});

test("an unknown or unpublished adapter path is rejected before any session is created", async () => {
  const { gateway, port } = await startGateway();
  try {
    await gateway.publish(probeManifest("fixture-a"));
    await assert.rejects(() => connectClient(port, "does-not-exist"));
  } finally {
    await gateway.close();
  }
});

test("a malformed percent-encoded or path-shaped adapter path is rejected as a client error and never crashes the gateway", async () => {
  const { gateway, port } = await startGateway();
  try {
    await gateway.publish(probeManifest("fixture-a"));

    const badPaths = [
      "/mcp/%zz", // invalid percent-encoding: not hex digits
      "/mcp/%", // truncated percent-encoding
      "/mcp/%e0%80", // percent-decodes to an incomplete UTF-8 sequence
      "/mcp/..%2f..%2fetc%2fpasswd", // path traversal, encoded
      "/mcp/foo%2fbar", // an encoded extra path separator
      "/mcp/Foo_Bar", // outside the manifest's own id charset
      "/mcp/a" // below the manifest's own minimum id length
    ];
    for (const badPath of badPaths) {
      const status = await rawGet(port, badPath);
      assert.ok(status >= 400 && status < 500, `expected a client error for ${badPath}, got ${status}`);
    }

    // None of the above may have destabilized the gateway -- the
    // already-published adapter must still route normally afterward.
    const client = await connectClient(port, "fixture-a");
    try {
      const tools = await client.listTools();
      assert.deepEqual(tools.tools.map((tool) => tool.name), ["fixture-a_probe"]);
    } finally {
      await client.close();
    }
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
    // fixture-a's session is gone: any further call on it fails, and its
    // path is rejected before a new session could ever be created.
    await assert.rejects(() => clientA.listTools());
    await assert.rejects(() => connectClient(port, "fixture-a"));

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

test("one adapter's process crashing does not break a sibling adapter's sessions", async () => {
  const { gateway, port, registry } = await startGateway();
  let clientA;
  let clientB;
  try {
    await gateway.publish(probeManifest("fixture-a"));
    await gateway.publish(probeManifest("fixture-b"));

    clientA = await connectClient(port, "fixture-a");
    clientB = await connectClient(port, "fixture-b");

    const resultA = probeResult(await clientA.callTool({ name: "fixture-a_probe" }));
    process.kill(resultA.pid, "SIGKILL");

    // fixture-a's own session eventually fails once its upstream process is
    // gone -- this is the crash observed, not the assertion under test.
    await assert.rejects(() => clientA.callTool({ name: "fixture-a_probe" }));

    // fixture-b, an entirely unrelated adapter sharing only the public
    // routing server, is untouched by fixture-a's crash.
    assert.equal(registry.get("fixture-b").state, AdapterState.RUNNING);
    const resultB = probeResult(await clientB.callTool({ name: "fixture-b_probe" }));
    assert.equal(resultB.adapterId, "fixture-b");
  } finally {
    await clientA?.close().catch(() => {});
    await clientB?.close();
    await gateway.close();
  }
});

test("a failed publish() leaves the errored registry entry observable until its lifecycle owner clears it", async () => {
  const { gateway, registry } = await startGateway();
  try {
    const broken = {
      schemaVersion: "1",
      id: "fixture-retry",
      version: "1.0.0",
      transport: createStdioGatewayTransport({ command: "/no/such/majiwari-fixture-command", connectionTimeout: 500 })
    };
    await assert.rejects(() => gateway.publish(broken));

    // Publication failure must not erase lifecycle state that the UI/runtime
    // needs to observe.
    assert.equal(registry.get("fixture-retry").state, AdapterState.ERRORED);
    assert.match(registry.get("fixture-retry").error, /ENOENT|no such file/i);

    // The lifecycle owner may explicitly clear a stopped entry before a
    // deliberate retry; gateway publication never performs that mutation.
    await gateway.unpublish("fixture-retry");
    registry.unregister("fixture-retry");

    const started = await gateway.publish(probeManifest("fixture-retry"));
    assert.equal(started.state, AdapterState.RUNNING);
    assert.equal(registry.get("fixture-retry").state, AdapterState.RUNNING);
  } finally {
    await gateway.close();
  }
});

test("attach requires a running gateway-routable registry entry and never starts or stops it", async () => {
  const { gateway, registry } = await startGateway();
  try {
    registry.register(probeManifest("fixture-attach"));
    await assert.rejects(
      () => gateway.attach("fixture-attach"),
      (error) => error instanceof GatewayAttachError && /not running/.test(error.message)
    );
    assert.equal(registry.get("fixture-attach").state, AdapterState.REGISTERED);

    await registry.start("fixture-attach");
    const resource = registry.resource("fixture-attach");
    await gateway.attach("fixture-attach");
    assert.equal(registry.get("fixture-attach").state, AdapterState.RUNNING);
    assert.equal(registry.resource("fixture-attach"), resource);

    await gateway.detach("fixture-attach");
    assert.equal(registry.get("fixture-attach").state, AdapterState.RUNNING);
    assert.equal(registry.resource("fixture-attach"), resource);
    await registry.stop("fixture-attach");
  } finally {
    await gateway.close();
  }
});

test("attach rejects unknown, failed, and non-routable entries without creating a bridge", async () => {
  const { gateway, registry } = await startGateway();
  try {
    await assert.rejects(() => gateway.attach("does-not-exist"), UnknownAdapterError);

    const failed = {
      schemaVersion: "1",
      id: "fixture-attach-failed",
      version: "1.0.0",
      transport: {
        kind: "stdio",
        start: async () => {
          throw new Error("fixture start failed");
        }
      }
    };
    registry.register(failed);
    await registry.start(failed.id);
    await assert.rejects(
      () => gateway.attach(failed.id),
      (error) => error instanceof GatewayAttachError && /state: errored/.test(error.message)
    );
    assert.equal(registry.get(failed.id).state, AdapterState.ERRORED);

    const nonRoutable = {
      schemaVersion: "1",
      id: "fixture-attach-resource",
      version: "1.0.0",
      transport: { kind: "stdio", start: async () => ({}) }
    };
    registry.register(nonRoutable);
    await registry.start(nonRoutable.id);
    await assert.rejects(
      () => gateway.attach(nonRoutable.id),
      (error) => error instanceof GatewayAttachError && /gateway-routable transport contract/.test(error.message)
    );
    assert.equal(registry.get(nonRoutable.id).state, AdapterState.RUNNING);
    await registry.stop(nonRoutable.id);
  } finally {
    await gateway.close();
  }
});

test("an externally mounted gateway never closes the ingress listener during disposal", async () => {
  const registry = new AdapterRegistry();
  const ingress = http.createServer();
  await new Promise((resolve) => ingress.listen(0, "127.0.0.1", resolve));
  const gateway = await createRegistryGateway({ registry, server: ingress });
  try {
    assert.equal(ingress.listening, true);
    await gateway.close();
    assert.equal(ingress.listening, true);
  } finally {
    await gateway.close();
    await new Promise((resolve) => ingress.close(resolve));
  }
});

test("a startup failure that partially acquired a resource (a spawned process) releases it instead of leaking it", async () => {
  const { gateway } = await startGateway();
  const pidFile = path.join(os.tmpdir(), `majiwari-gateway-test-${randomUUID()}.pid`);
  try {
    const manifest = {
      schemaVersion: "1",
      id: "fixture-hang",
      version: "1.0.0",
      transport: createStdioGatewayTransport({ command: process.execPath, args: [HANGING_SERVER, pidFile], connectionTimeout: 300 })
    };

    await assert.rejects(() => gateway.publish(manifest));

    const pid = Number(await waitFor(() => (fs.existsSync(pidFile) ? fs.readFileSync(pidFile, "utf8").trim() : undefined)));
    assert.ok(Number.isInteger(pid) && pid > 0);

    // The connect() timeout must have released the process it partially
    // acquired -- it must not still be running once publish() has rejected.
    await waitFor(() => !isProcessAlive(pid));
  } finally {
    await gateway.close();
    fs.rmSync(pidFile, { force: true });
  }
});
