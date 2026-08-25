import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { AdapterRegistry, AdapterState } from "@majiwari/registry";
import { createRegistryGateway, createStdioGatewayTransport } from "../src/index.js";
import { createUiHandler } from "../../ui/src/server.js";
import { fileURLToPath } from "node:url";

const PROBE_SERVER = fileURLToPath(new URL("./fixtures/probe-server.mjs", import.meta.url));

function probeManifest(id) {
  return {
    schemaVersion: "1",
    id,
    version: "1.0.0",
    displayName: `Fixture ${id}`,
    transport: createStdioGatewayTransport({ command: process.execPath, args: [PROBE_SERVER, id] })
  };
}

function failingManifest(id) {
  return {
    schemaVersion: "1",
    id,
    version: "1.0.0",
    displayName: `Failed ${id}`,
    transport: {
      kind: "stdio",
      start: async () => {
        throw new Error("fixture startup failed");
      }
    }
  };
}

async function listen(server) {
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return server.address().port;
}

function rawGet(port, rawPath) {
  return new Promise((resolve, reject) => {
    const request = http.request({ host: "127.0.0.1", method: "GET", path: rawPath, port }, (response) => {
      response.resume();
      response.on("end", () => resolve(response.statusCode));
    });
    request.on("error", reject);
    request.end();
  });
}

async function connectClient(port, adapterId) {
  const client = new Client({ name: `shared-ingress-${adapterId}`, version: "1.0.0" }, { capabilities: {} });
  await client.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/mcp/${adapterId}`)));
  return client;
}

function probeResult(result) {
  return JSON.parse(result.content[0].text);
}

test("one external ingress serves two MCP adapters and the UI without cross-routing", async () => {
  const registry = new AdapterRegistry();
  const gateway = await createRegistryGateway({ registry });
  const ui = createUiHandler(registry, { basePath: "/ui" });
  const ingress = http.createServer(async (req, res) => {
    if (await gateway.handle(req, res)) return;
    if (await ui(req, res)) return;
    res.writeHead(404).end();
  });
  const port = await listen(ingress);
  let clientA;
  let clientB;

  try {
    registry.register(probeManifest("fixture-a"));
    registry.register(probeManifest("fixture-b"));
    registry.register(failingManifest("fixture-failed"));
    const stoppedManifest = probeManifest("fixture-stopped");
    registry.register(stoppedManifest);

    await registry.start("fixture-a");
    await registry.start("fixture-b");
    await registry.start("fixture-failed");
    await registry.start("fixture-stopped");
    await registry.stop("fixture-stopped");

    await gateway.attach("fixture-a");
    await gateway.attach("fixture-b");

    clientA = await connectClient(port, "fixture-a");
    clientB = await connectClient(port, "fixture-b");
    assert.deepEqual((await clientA.listTools()).tools.map((tool) => tool.name), ["fixture-a_probe"]);
    assert.deepEqual((await clientB.listTools()).tools.map((tool) => tool.name), ["fixture-b_probe"]);

    const resultA = probeResult(await clientA.callTool({ name: "fixture-a_probe" }));
    const resultB = probeResult(await clientB.callTool({ name: "fixture-b_probe" }));
    assert.equal(resultA.adapterId, "fixture-a");
    assert.equal(resultB.adapterId, "fixture-b");
    await assert.rejects(() => clientA.callTool({ name: "fixture-b_probe" }));

    const uiPage = await fetch(`http://127.0.0.1:${port}/ui`);
    assert.equal(uiPage.status, 200);
    assert.match(await uiPage.text(), /Majiwari/);
    assert.equal((await fetch(`http://127.0.0.1:${port}/ui/app.js`)).status, 200);

    const projectionResponse = await fetch(`http://127.0.0.1:${port}/ui/api/adapters`);
    assert.equal(projectionResponse.status, 200);
    const projection = await projectionResponse.json();
    const byId = Object.fromEntries(projection.map((adapter) => [adapter.id, adapter]));
    assert.equal(byId["fixture-a"].state, AdapterState.RUNNING);
    assert.equal(byId["fixture-b"].state, AdapterState.RUNNING);
    assert.equal(byId["fixture-failed"].state, AdapterState.ERRORED);
    assert.equal(byId["fixture-stopped"].state, AdapterState.STOPPED);
    assert.equal("resource" in byId["fixture-a"], false);

    const detail = await fetch(`http://127.0.0.1:${port}/ui/api/adapters/fixture-failed`);
    assert.equal(detail.status, 200);
    assert.equal((await detail.json()).state, AdapterState.ERRORED);

    // The shared listener rejects malformed/path-shaped identifiers without
    // invoking either MCP bridge, and remains healthy afterward.
    for (const rawPath of [
      "/mcp/%zz",
      "/mcp/%",
      "/mcp/..%2f..%2fetc%2fpasswd",
      "/mcp/fixture-a/extra",
      "/mcp/unknown-adapter",
      "/ui/api/adapters/%zz",
      "/unrelated"
    ]) {
      const status = await rawGet(port, rawPath);
      assert.ok(status >= 400 && status < 500, `${rawPath} returned ${status}`);
    }
    assert.equal((await fetch(`http://127.0.0.1:${port}/ui`)).status, 200);

    const resourceA = registry.resource("fixture-a");
    await gateway.detach("fixture-a");
    assert.equal(registry.get("fixture-a").state, AdapterState.RUNNING);
    assert.equal(registry.resource("fixture-a"), resourceA);
    await assert.rejects(() => clientA.listTools());
    assert.deepEqual((await clientB.listTools()).tools.map((tool) => tool.name), ["fixture-b_probe"]);

    await gateway.close();
    // Gateway disposal detached only explicitly attached bridges. The
    // lifecycle owner still owns the running upstream entries and the
    // externally-owned ingress remains open until the test closes it.
    assert.equal(registry.get("fixture-b").state, AdapterState.RUNNING);
    assert.equal(ingress.listening, true);
  } finally {
    await clientA?.close().catch(() => {});
    await clientB?.close().catch(() => {});
    await gateway.close();
    await registry.stop("fixture-a").catch(() => {});
    await registry.stop("fixture-b").catch(() => {});
    await registry.stop("fixture-failed").catch(() => {});
    await registry.stop("fixture-stopped").catch(() => {});
    await new Promise((resolve) => ingress.close(resolve));
  }
});
