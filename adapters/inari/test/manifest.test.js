import test from "node:test";
import assert from "node:assert/strict";
import { AdapterRegistry, AdapterState } from "@majiwari/registry";
import { ADAPTER_ID, ADAPTER_VERSION, createManifest } from "../src/manifest.js";

test("manifest registers through the generic registry contract", () => {
  const registry = new AdapterRegistry();
  const manifest = createManifest();
  const entry = registry.register(manifest);

  assert.equal(entry.id, ADAPTER_ID);
  assert.equal(entry.version, ADAPTER_VERSION);
  assert.equal(entry.transportKind, "stdio");
  assert.equal(entry.state, AdapterState.REGISTERED);
});

test("manifest starts and stops the Inari MCP server as a stdio child process", async () => {
  const registry = new AdapterRegistry();
  registry.register(createManifest());

  const started = await registry.start(ADAPTER_ID);
  assert.equal(started.state, AdapterState.RUNNING);
  assert.equal(started.error, undefined);

  const stopped = await registry.stop(ADAPTER_ID);
  assert.equal(stopped.state, AdapterState.STOPPED);
});

test("adapter health is surfaced through the generic registry contract", async () => {
  const registry = new AdapterRegistry();
  registry.register(createManifest());
  await registry.start(ADAPTER_ID);

  const health = await registry.health(ADAPTER_ID);
  assert.equal(health.id, ADAPTER_ID);
  assert.equal(health.state, AdapterState.RUNNING);
  assert.equal(typeof health.ok, "boolean");

  await registry.stop(ADAPTER_ID);
});
