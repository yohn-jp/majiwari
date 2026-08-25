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
import { resolveRepoRoot } from "../src/core.js";
import { ADAPTER_ID, createManifest } from "../src/manifest.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SIBLING_SERVER = path.join(__dirname, "..", "fixtures", "sibling-server.js");

const EXPECTED_TOOL_NAMES = [
  "adapter_health",
  "inari_template_list",
  "inari_issue_schema",
  "inari_pr_schema",
  "inari_issue_get",
  "inari_pr_get",
  "inari_issue_validate",
  "inari_pr_validate",
  "inari_issue_create",
  "inari_pr_create"
];

// Names a raw shell/unrestricted-`gh`-passthrough tool would plausibly use.
// Asserted absent both from the published tool list and as a callable name.
const DISALLOWED_TOOL_NAMES = ["shell", "exec", "run_command", "gh", "gh_exec", "gh_passthrough", "raw_gh"];

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

function createSiblingManifest(id) {
  const transport = createStdioGatewayTransport({ command: process.execPath, args: [SIBLING_SERVER] });
  return {
    schemaVersion: "1",
    id,
    version: "1.0.0",
    displayName: "Inari test sibling",
    transport: {
      kind: "stdio",
      start: () => transport.start(),
      stop: (handle) => transport.stop(handle)
    },
    listTools: async () => [{ name: "ping" }],
    capabilities: ["fixture"]
  };
}

/**
 * Fake `inari`/`gh` binaries on PATH, so this suite proves the merged
 * gateway/registry contract (registration, lifecycle, publication, tool
 * surface, a real tool call round trip) without depending on the real
 * `gh-inari` CLI or GitHub credentials being present in the environment
 * that runs it. The real `gh-inari` CLI's own machine-readable protocol/
 * capability surface is separately verified against the real, currently
 * resolved (not pinned) binary by `.github/workflows/ci.yml`'s
 * `inari-contract` job.
 */
function withFakeInariOnPath(fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "inari-gateway-fake-"));
  const inariPath = path.join(dir, "inari");
  const ghPath = path.join(dir, "gh");
  fs.writeFileSync(
    inariPath,
    [
      "#!/bin/sh",
      'if [ "$1" = "--version" ]; then',
      "  echo '{\"ok\":true,\"name\":\"gh-inari\",\"version\":\"0.8.0\",\"protocol\":1,\"capabilities\":[\"canonical-invocation\",\"machine-readable-version\"]}'",
      "  exit 0",
      "fi",
      'if [ "$1" = "template" ] && [ "$2" = "list" ]; then',
      "  echo '{\"templates\":[{\"id\":\"feature\"}],\"semanticTemplates\":[]}'",
      "  exit 0",
      "fi",
      "echo '{\"ok\":false,\"error\":{\"message\":\"unsupported fixture invocation\"}}'",
      "exit 1"
    ].join("\n")
  );
  fs.writeFileSync(ghPath, "#!/bin/sh\nexit 0\n");
  fs.chmodSync(inariPath, 0o755);
  fs.chmodSync(ghPath, 0o755);
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

/**
 * Proves the real Inari adapter (not a fixture) satisfies the merged
 * registry/gateway generic contract end to end: it registers and starts
 * through the shared registry lifecycle, its stdio transport resolves the
 * explicit gateway-routable handle shape, the gateway publishes it at
 * /mcp/inari, its bounded MCP tool surface (names, schemas, and a real
 * read-only structured tool call's result) is reachable through that
 * endpoint unchanged, no raw shell or unrestricted `gh` passthrough tool is
 * published or callable, and stopping it leaves no child process behind.
 */
test("Inari adapter registers, starts, and is published through the gateway at /mcp/inari, with no raw shell or gh passthrough", async () => {
  await withFakeInariOnPath(async () => {
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

      client = new Client({ name: "inari-gateway-integration-test", version: "1.0.0" }, { capabilities: {} });
      await client.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/mcp/${ADAPTER_ID}`)));

      const { tools } = await client.listTools();
      const names = tools.map((tool) => tool.name).sort();
      assert.deepEqual(names, [...EXPECTED_TOOL_NAMES].sort());
      for (const disallowed of DISALLOWED_TOOL_NAMES) {
        assert.ok(!names.includes(disallowed), `unexpected raw/passthrough tool "${disallowed}" is published`);
      }

      // Not merely absent from this adapter's own name list above: the MCP
      // server behind the gateway itself refuses a call to a tool name that
      // was never registered, through the gateway unchanged.
      const shellAttempt = await client.callTool({ name: "shell", arguments: { command: "echo hi" } });
      assert.equal(shellAttempt.isError, true);
      assert.match(shellAttempt.content[0].text, /not found/);

      const health = await client.callTool({ name: "adapter_health", arguments: {} });
      assert.equal(health.isError, undefined);
      assert.equal(health.structuredContent.ok, true);
      assert.equal(health.structuredContent.inari_compatible, true);
      assert.equal(health.structuredContent.github_authenticated, true);

      // adapter_health is a remote MCP surface: it must never expose the
      // host's absolute repository path, in the structured result or its
      // text summary.
      assert.ok(!("repo_root" in health.structuredContent));
      const expectedRepoRoot = await resolveRepoRoot();
      const healthText = health.content.map((entry) => entry.text ?? "").join(" ");
      assert.ok(!healthText.includes(expectedRepoRoot), "adapter_health text leaked the local repository path");

      // A representative read-only structured Inari operation, executed
      // end to end through the published gateway endpoint.
      const templates = await client.callTool({ name: "inari_template_list", arguments: {} });
      assert.equal(templates.isError, undefined);
      assert.deepEqual(templates.structuredContent.templates, [{ id: "feature" }]);
    } finally {
      await client?.close();
      await gateway.close();
    }

    // Stopping/unpublishing released the child process -- nothing leaked.
    await waitForExit(pid);
    assert.equal(isProcessAlive(pid), false);
  });
});

test("Inari adapter's generic tool discovery matches its live MCP tool surface, and is empty while stopped", async () => {
  await withFakeInariOnPath(async () => {
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
});

test("manifest health() surfaces Inari compatibility flags but strips the repository's absolute filesystem path", async () => {
  await withFakeInariOnPath(async () => {
    const health = await createManifest().health();
    assert.equal(health.ok, true);
    assert.equal(health.inari_compatible, true);
    assert.equal(typeof health.inari_version, "string");
    assert.ok(!("repo_root" in health));
  });
});

test("adapter health is surfaced through the generic registry contract without leaking a repository path", async () => {
  await withFakeInariOnPath(async () => {
    const registry = new AdapterRegistry();
    registry.register(createManifest());
    await registry.start(ADAPTER_ID);
    try {
      const health = await registry.health(ADAPTER_ID);
      assert.equal(health.id, ADAPTER_ID);
      assert.equal(health.state, AdapterState.RUNNING);
      assert.equal(health.ok, true);
      assert.ok(!("repo_root" in health.detail));
    } finally {
      await registry.stop(ADAPTER_ID);
    }
  });
});

/**
 * Proves adapter isolation at the gateway level (not just inside one
 * registry entry, per registry/test/registry.test.js): a sibling adapter
 * published on the same createRegistryGateway instance keeps working,
 * unaffected, both while Inari is running and after Inari is stopped.
 */
test("stopping the Inari adapter does not affect a sibling adapter published on the same gateway", async () => {
  await withFakeInariOnPath(async () => {
    const { gateway, port, registry } = await startGateway();
    const siblingId = "inari-test-sibling";
    let inariClient;
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

      // Simulate Inari failing/being taken down independently of its sibling.
      await gateway.unpublish(ADAPTER_ID);
      assert.equal(registry.get(ADAPTER_ID).state, AdapterState.STOPPED);

      // The sibling's own resource, session, and route are untouched.
      assert.equal(registry.get(siblingId).state, AdapterState.RUNNING);
      siblingClient = new Client({ name: "sibling-check-after", version: "1.0.0" }, { capabilities: {} });
      await siblingClient.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/mcp/${siblingId}`)));
      const afterPing = await siblingClient.callTool({ name: "ping", arguments: {} });
      assert.equal(afterPing.structuredContent.pong, true);

      // Inari's own route now correctly reports it as gone, rather than
      // silently falling through to the sibling's bridge.
      inariClient = new Client({ name: "inari-check-after-stop", version: "1.0.0" }, { capabilities: {} });
      await assert.rejects(inariClient.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/mcp/${ADAPTER_ID}`))));
    } finally {
      await inariClient?.close().catch(() => {});
      await siblingClient?.close().catch(() => {});
      await gateway.close();
    }
  });
});
