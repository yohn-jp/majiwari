import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { AdapterRegistry, AdapterState } from "@majiwari/registry";
import { createRegistryGateway } from "@majiwari/gateway";
import { ADAPTER_ID, createManifest } from "../src/manifest.js";

const EXPECTED_TOOL_NAMES = [
  "adapter_health",
  "ocr_delegate_preview",
  "ocr_delegate_rules",
  "scan_delegate_preview",
  "ocr_rules_check",
  "repo_diff",
  "repo_read_file",
  "repo_search"
];

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

/**
 * Proves the real OCR adapter (not a fixture) satisfies the merged
 * registry/gateway generic contract end to end: it registers and starts
 * through the shared registry lifecycle, its stdio transport resolves the
 * explicit gateway-routable handle shape, the gateway publishes it at
 * /mcp/open-code-review, its existing MCP tool surface (names, schemas, and
 * a real tool call's result) is reachable through that endpoint unchanged,
 * and stopping it leaves no child process behind. Calls `repo_search`
 * (bounded `git grep`) rather than an `ocr`-CLI-backed tool, so this test
 * does not depend on the `ocr` binary being installed in the environment
 * that runs it -- only `git`, which every checkout already has.
 */
test("OCR adapter registers, starts, and is published through the gateway at /mcp/open-code-review", async () => {
  const { gateway, port, registry } = await startGateway();
  let client;
  let pid;
  try {
    const published = await gateway.publish(createManifest());
    assert.equal(published.id, ADAPTER_ID);
    assert.equal(published.state, AdapterState.RUNNING);

    // The stdio transport resolved the explicit gateway-routable contract
    // (gateway/src/gateway-transport.js): a connected mcpClient plus the
    // serverVersion/serverCapabilities it negotiated.
    const resource = registry.resource(ADAPTER_ID);
    assert.equal(typeof resource.mcpClient.request, "function");
    assert.ok(resource.serverVersion);
    assert.ok(resource.serverCapabilities);
    pid = resource.mcpClient.transport.pid;
    assert.ok(isProcessAlive(pid));

    client = new Client({ name: "ocr-gateway-integration-test", version: "1.0.0" }, { capabilities: {} });
    await client.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/mcp/${ADAPTER_ID}`)));

    const { tools } = await client.listTools();
    assert.deepEqual(
      tools.map((tool) => tool.name).sort(),
      [...EXPECTED_TOOL_NAMES].sort()
    );

    const searched = await client.callTool({ name: "repo_search", arguments: { query: "majiwari", paths: ["package.json"] } });
    assert.equal(searched.isError, undefined);
    assert.equal(searched.structuredContent.found, true);
    assert.match(searched.structuredContent.matches, /majiwari/);
  } finally {
    await client?.close();
    await gateway.close();
  }

  // Stopping/unpublishing released the child process -- nothing leaked.
  await waitForExit(pid);
  assert.equal(isProcessAlive(pid), false);
});

test("OCR adapter's generic tool discovery matches its live MCP tool surface, and is empty while stopped", async () => {
  const registry = new AdapterRegistry();
  registry.register(createManifest());

  assert.deepEqual(await registry.tools(ADAPTER_ID), []);

  await registry.start(ADAPTER_ID);
  try {
    const tools = await registry.tools(ADAPTER_ID);
    assert.deepEqual(
      tools.map((tool) => tool.name).sort(),
      [...EXPECTED_TOOL_NAMES].sort()
    );
  } finally {
    await registry.stop(ADAPTER_ID);
  }

  assert.deepEqual(await registry.tools(ADAPTER_ID), []);
});

/**
 * `checkAdapterHealth()` (`src/core.js`) shells out to the real `ocr` CLI,
 * which is not guaranteed to be installed wherever this suite runs. A fake
 * `ocr` on PATH makes this deterministic regardless, and keeps the
 * assertion about what the *manifest* does with the result (strip
 * `repo_root`) independent of what `ocr` itself reports.
 */
function withFakeOcrOnPath(fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ocr-fake-"));
  const fakeOcr = path.join(dir, "ocr");
  fs.writeFileSync(fakeOcr, "#!/bin/sh\necho '1.0.0'\necho '--preview --format <file-path>'\n");
  fs.chmodSync(fakeOcr, 0o755);
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

test("manifest health() surfaces adapter support flags but strips the repository's absolute filesystem path", async () => {
  await withFakeOcrOnPath(async () => {
    const health = await createManifest().health();
    assert.equal(health.ok, true);
    assert.equal(typeof health.git_version, "string");
    assert.equal(typeof health.ocr_version, "string");
    assert.equal(health.repo_root, undefined);
  });
});

test("adapter health is surfaced through the generic registry contract without leaking a repository path", async () => {
  await withFakeOcrOnPath(async () => {
    const registry = new AdapterRegistry();
    registry.register(createManifest());
    await registry.start(ADAPTER_ID);
    try {
      const health = await registry.health(ADAPTER_ID);
      assert.equal(health.id, ADAPTER_ID);
      assert.equal(health.state, AdapterState.RUNNING);
      assert.equal(health.ok, true);
      assert.equal(health.detail.repo_root, undefined);
    } finally {
      await registry.stop(ADAPTER_ID);
    }
  });
});
