import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { AdapterRegistry, AdapterState } from "@majiwari/registry";
import { createRegistryGateway, createStdioGatewayTransport } from "@majiwari/gateway";
import { ADAPTER_ID, createManifest } from "../src/manifest.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE_SERVER = path.join(__dirname, "..", "fixtures", "fake-mottainai-mcp.mjs");
const SIBLING_SERVER = path.join(__dirname, "..", "..", "inari", "fixtures", "sibling-server.js");

const EXPECTED_TOOL_NAMES = ["mottainai_cancel_work", "mottainai_continue_work", "mottainai_delegate_work", "mottainai_harness_capabilities", "mottainai_inspect_work"];

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

async function startGateway() {
  const registry = new AdapterRegistry();
  const port = await getFreePort();
  const gateway = await createRegistryGateway({ registry, host: "127.0.0.1", port });
  return { gateway, port, registry };
}

function isProcessAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function waitForExit(pid, { timeoutMs = 5000, intervalMs = 20 } = {}) {
  const deadline = Date.now() + timeoutMs;
  while (isProcessAlive(pid)) {
    if (Date.now() > deadline) throw new Error("waitForExit: timed out");
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
}

/** See adapters/mottainai/test/manifest.test.js for why this fake exists. */
function withFakeMottainaiMcpOnPath(fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mottainai-gateway-fake-"));
  const binPath = path.join(dir, "mottainai-mcp");
  fs.writeFileSync(binPath, `#!/bin/sh\nexec "${process.execPath}" "${FIXTURE_SERVER}" "$@"\n`);
  fs.chmodSync(binPath, 0o755);
  const originalPath = process.env.PATH;
  process.env.PATH = `${dir}${path.delimiter}${originalPath}`;
  return (async () => {
    try {
      return await fn();
    } finally {
      process.env.PATH = originalPath;
      fs.rmSync(dir, { recursive: true, force: true });
    }
  })();
}

function createSiblingManifest(id) {
  const transport = createStdioGatewayTransport({ command: process.execPath, args: [SIBLING_SERVER] });
  return {
    schemaVersion: "1",
    id,
    version: "1.0.0",
    displayName: "Mottainai test sibling",
    transport: {
      kind: "stdio",
      start: () => transport.start(),
      stop: (handle) => transport.stop(handle)
    },
    listTools: async () => [{ name: "ping" }],
    capabilities: ["fixture"]
  };
}

test("Mottainai adapter registers, starts, and is published through the gateway at /mcp/mottainai, with delegate/inspect passthrough", async () => {
  await withFakeMottainaiMcpOnPath(async () => {
    const { gateway, port, registry } = await startGateway();
    let client;
    let pid;
    try {
      const published = await gateway.publish(createManifest());
      assert.equal(published.id, ADAPTER_ID);
      assert.equal(published.state, AdapterState.RUNNING);

      const resource = registry.resource(ADAPTER_ID);
      assert.equal(typeof resource.mcpClient.request, "function");
      pid = resource.mcpClient.transport.pid;
      assert.ok(isProcessAlive(pid));

      client = new Client({ name: "mottainai-gateway-integration-test", version: "1.0.0" }, { capabilities: {} });
      await client.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/mcp/${ADAPTER_ID}`)));

      const { tools } = await client.listTools();
      assert.deepEqual(tools.map((tool) => tool.name).sort(), [...EXPECTED_TOOL_NAMES].sort());

      const delegated = await client.callTool({ name: "mottainai_delegate_work", arguments: { goal: "do the thing" } });
      assert.equal(delegated.isError, undefined);
      assert.equal(delegated.structuredContent.schemaVersion, 1);
      assert.equal(delegated.structuredContent.status, "accepted");
      const { workId } = delegated.structuredContent;
      assert.ok(typeof workId === "string" && workId.length > 0);

      const inspected = await client.callTool({ name: "mottainai_inspect_work", arguments: { workId } });
      assert.equal(inspected.isError, undefined);
      assert.deepEqual(inspected.structuredContent, { schemaVersion: 1, workId, status: "accepted" });

      const missing = await client.callTool({ name: "mottainai_inspect_work", arguments: { workId: "never-delegated" } });
      assert.deepEqual(missing.structuredContent, { schemaVersion: 1, workId: "never-delegated", status: "missing" });
    } finally {
      await client?.close();
      await gateway.close();
    }

    await waitForExit(pid);
    assert.equal(isProcessAlive(pid), false);
  });
});

test("the optional 'config' selector is passed through as --config <path> and nothing else", async () => {
  await withFakeMottainaiMcpOnPath(async () => {
    const registry = new AdapterRegistry();
    const configPath = path.join(os.tmpdir(), "mottainai.config.json");
    registry.register(createManifest({ config: configPath }));
    await registry.start(ADAPTER_ID);
    try {
      const resource = registry.resource(ADAPTER_ID);
      const capabilities = await resource.mcpClient.callTool({ name: "mottainai_harness_capabilities", arguments: {} });
      assert.equal(capabilities.structuredContent.configPath, configPath);
    } finally {
      await registry.stop(ADAPTER_ID);
    }
  });
});

test("stopping the Mottainai adapter does not affect a sibling adapter published on the same gateway", async () => {
  await withFakeMottainaiMcpOnPath(async () => {
    const { gateway, port, registry } = await startGateway();
    const siblingId = "mottainai-test-sibling";
    let mottainaiClient;
    let siblingClient;
    try {
      await gateway.publish(createManifest());
      await gateway.publish(createSiblingManifest(siblingId));

      siblingClient = new Client({ name: "sibling-check", version: "1.0.0" }, { capabilities: {} });
      await siblingClient.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/mcp/${siblingId}`)));
      const beforePing = await siblingClient.callTool({ name: "ping", arguments: {} });
      assert.equal(beforePing.structuredContent.pong, true);
      await siblingClient.close();
      siblingClient = undefined;

      mottainaiClient = new Client({ name: "mottainai-check", version: "1.0.0" }, { capabilities: {} });
      await mottainaiClient.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/mcp/${ADAPTER_ID}`)));
      const delegated = await mottainaiClient.callTool({ name: "mottainai_delegate_work", arguments: { goal: "isolation check" } });
      assert.equal(delegated.structuredContent.status, "accepted");
      await mottainaiClient.close();
      mottainaiClient = undefined;

      await gateway.unpublish(ADAPTER_ID);
      assert.equal(registry.get(ADAPTER_ID).state, AdapterState.STOPPED);

      assert.equal(registry.get(siblingId).state, AdapterState.RUNNING);
      siblingClient = new Client({ name: "sibling-check-after", version: "1.0.0" }, { capabilities: {} });
      await siblingClient.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/mcp/${siblingId}`)));
      const afterPing = await siblingClient.callTool({ name: "ping", arguments: {} });
      assert.equal(afterPing.structuredContent.pong, true);

      // Verify route removal without constructing a client transport whose
      // failed initialization can retain an HTTP handle until process exit.
      const stoppedRoute = await fetch(`http://127.0.0.1:${port}/mcp/${ADAPTER_ID}`, { method: "POST" });
      assert.equal(stoppedRoute.status, 404);
      await stoppedRoute.body?.cancel();
    } finally {
      await mottainaiClient?.close().catch(() => {});
      await siblingClient?.close().catch(() => {});
      await gateway.close();
    }
  });
});
