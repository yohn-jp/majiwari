import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { AdapterRegistry, AdapterState } from "@majiwari/registry";
import { ADAPTER_ID, ADAPTER_VERSION, createManifest } from "../src/manifest.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE_SERVER = path.join(__dirname, "..", "fixtures", "fake-mottainai-mcp.mjs");

/**
 * Puts a fake `mottainai-mcp` executable on PATH so this suite proves the
 * adapter's own stdio/registry plumbing without depending on the real
 * Mottainai package (yohn-jp/mottainai#548) being installed wherever these
 * tests run -- mirroring `adapters/inari/test/gateway-integration.test.js`'s
 * `withFakeInariOnPath`. The fake is a tiny shell shim that execs Node
 * against the fixture server so it behaves like any other PATH-resolved
 * binary the real stdio transport would spawn.
 */
function withFakeMottainaiMcpOnPath(fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mottainai-adapter-fake-"));
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

test("manifest registers through the generic registry contract", () => {
  const registry = new AdapterRegistry();
  const manifest = createManifest();
  const entry = registry.register(manifest);

  assert.equal(entry.id, ADAPTER_ID);
  assert.equal(entry.version, ADAPTER_VERSION);
  assert.equal(entry.transportKind, "stdio");
  assert.equal(entry.state, AdapterState.REGISTERED);
});

test("manifest starts and stops the Mottainai MCP entrypoint as a stdio child process", async () => {
  await withFakeMottainaiMcpOnPath(async () => {
    const registry = new AdapterRegistry();
    registry.register(createManifest());

    const started = await registry.start(ADAPTER_ID);
    assert.equal(started.state, AdapterState.RUNNING, started.error);

    const resource = registry.resource(ADAPTER_ID);
    assert.equal(typeof resource.mcpClient.request, "function");
    assert.ok(resource.serverVersion);
    assert.ok(resource.serverCapabilities);

    const stopped = await registry.stop(ADAPTER_ID);
    assert.equal(stopped.state, AdapterState.STOPPED);
  });
});

test("adapter fails closed, without leaking a repository/local path, when no mottainai-mcp is on PATH", async () => {
  const registry = new AdapterRegistry();
  registry.register(createManifest());

  const started = await registry.start(ADAPTER_ID);
  assert.equal(started.state, AdapterState.ERRORED);
  assert.ok(started.error);
});

test("generic tool discovery matches the live MCP tool surface, and is empty while stopped", async () => {
  await withFakeMottainaiMcpOnPath(async () => {
    const registry = new AdapterRegistry();
    registry.register(createManifest());

    assert.deepEqual(await registry.tools(ADAPTER_ID), []);

    await registry.start(ADAPTER_ID);
    try {
      const tools = await registry.tools(ADAPTER_ID);
      assert.deepEqual(
        tools.map((tool) => tool.name).sort(),
        ["mottainai_cancel_work", "mottainai_continue_work", "mottainai_delegate_work", "mottainai_harness_capabilities", "mottainai_inspect_work"]
      );
    } finally {
      await registry.stop(ADAPTER_ID);
    }

    assert.deepEqual(await registry.tools(ADAPTER_ID), []);
  });
});

test("registry lifecycle state alone reports adapter health with no manifest-level health() declared", async () => {
  await withFakeMottainaiMcpOnPath(async () => {
    const registry = new AdapterRegistry();
    registry.register(createManifest());
    await registry.start(ADAPTER_ID);
    try {
      const health = await registry.health(ADAPTER_ID);
      assert.equal(health.id, ADAPTER_ID);
      assert.equal(health.state, AdapterState.RUNNING);
      assert.equal(health.ok, true);
    } finally {
      await registry.stop(ADAPTER_ID);
    }
  });
});
