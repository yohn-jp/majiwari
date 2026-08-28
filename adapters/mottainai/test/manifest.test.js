import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { AdapterRegistry, AdapterState } from "@majiwari/registry";
import { ADAPTER_ID, ADAPTER_VERSION, DEFAULT_MOTTAINAI_MCP_COMMAND, createManifest } from "../src/manifest.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE_SERVER = path.join(__dirname, "..", "fixtures", "fake-mottainai-mcp.mjs");

function isProcessAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function waitForExit(pid, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  while (isProcessAlive(pid)) {
    if (Date.now() > deadline) throw new Error("fixture process did not exit");
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

function withFakeMottainaiMcpOnPath(fn, { incompatible = false, pidFile } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mottainai-adapter-fake-"));
  const binPath = path.join(dir, DEFAULT_MOTTAINAI_MCP_COMMAND);
  fs.writeFileSync(binPath, `#!/bin/sh\nexec "${process.execPath}" "${FIXTURE_SERVER}" "$@"\n`);
  fs.chmodSync(binPath, 0o755);
  const originalPath = process.env.PATH;
  const originalIncompatible = process.env.MAJIWARI_TEST_MOTTAINAI_INCOMPATIBLE;
  const originalPidFile = process.env.MAJIWARI_TEST_MOTTAINAI_PID_FILE;
  process.env.PATH = `${dir}${path.delimiter}${originalPath}`;
  if (incompatible) process.env.MAJIWARI_TEST_MOTTAINAI_INCOMPATIBLE = "1";
  else delete process.env.MAJIWARI_TEST_MOTTAINAI_INCOMPATIBLE;
  if (pidFile) process.env.MAJIWARI_TEST_MOTTAINAI_PID_FILE = pidFile;
  else delete process.env.MAJIWARI_TEST_MOTTAINAI_PID_FILE;
  return (async () => {
    try {
      return await fn();
    } finally {
      process.env.PATH = originalPath;
      if (originalIncompatible === undefined) delete process.env.MAJIWARI_TEST_MOTTAINAI_INCOMPATIBLE;
      else process.env.MAJIWARI_TEST_MOTTAINAI_INCOMPATIBLE = originalIncompatible;
      if (originalPidFile === undefined) delete process.env.MAJIWARI_TEST_MOTTAINAI_PID_FILE;
      else process.env.MAJIWARI_TEST_MOTTAINAI_PID_FILE = originalPidFile;
      fs.rmSync(dir, { recursive: true, force: true });
    }
  })();
}

test("manifest registers through the generic registry contract", () => {
  const registry = new AdapterRegistry();
  const entry = registry.register(createManifest());
  assert.equal(entry.id, ADAPTER_ID);
  assert.equal(entry.version, ADAPTER_VERSION);
  assert.equal(entry.transportKind, "stdio");
  assert.equal(entry.state, AdapterState.REGISTERED);
  assert.equal(DEFAULT_MOTTAINAI_MCP_COMMAND, "mottainai-mcp");
});

test("manifest starts only a compatible Mottainai MCP entrypoint and stops it", async () => {
  await withFakeMottainaiMcpOnPath(async () => {
    const registry = new AdapterRegistry();
    registry.register(createManifest());
    const started = await registry.start(ADAPTER_ID);
    assert.equal(started.state, AdapterState.RUNNING, started.error);
    const resource = registry.resource(ADAPTER_ID);
    assert.equal(resource.serverVersion.name, "mottainai-mcp");
    assert.equal(typeof resource.mcpClient.request, "function");
    const stopped = await registry.stop(ADAPTER_ID);
    assert.equal(stopped.state, AdapterState.STOPPED);
  });
});

test("incompatible Mottainai identity/capability contract fails closed and child is reaped", async () => {
  const pidFile = path.join(os.tmpdir(), `majiwari-mottainai-${process.pid}-${Date.now()}.pid`);
  await withFakeMottainaiMcpOnPath(async () => {
    const registry = new AdapterRegistry();
    registry.register(createManifest());
    const started = await registry.start(ADAPTER_ID);
    assert.equal(started.state, AdapterState.ERRORED);
    assert.equal(started.error, "installed mottainai-mcp does not satisfy the supported native harness MCP contract");
    const pid = Number(fs.readFileSync(pidFile, "utf8"));
    await waitForExit(pid);
    assert.equal(isProcessAlive(pid), false);
  }, { incompatible: true, pidFile });
  fs.rmSync(pidFile, { force: true });
});

test("adapter fails closed when mottainai-mcp is unavailable", async () => {
  const registry = new AdapterRegistry();
  registry.register(createManifest());
  const originalPath = process.env.PATH;
  process.env.PATH = "";
  try {
    const started = await registry.start(ADAPTER_ID);
    assert.equal(started.state, AdapterState.ERRORED);
    assert.ok(started.error);
  } finally {
    process.env.PATH = originalPath;
  }
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

test("registry lifecycle health is running only after compatibility preflight succeeds", async () => {
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
