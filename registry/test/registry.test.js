import test from "node:test";
import assert from "node:assert/strict";
import { AdapterManifestError } from "../src/manifest.js";
import { AdapterRegistry, AdapterState, DuplicateAdapterError, UnknownAdapterError } from "../src/registry.js";
import { createFailingFixtureManifest, createFixtureManifest } from "./fixtures/fixture-adapter.js";

test("register validates the manifest and reports the registered state", () => {
  const registry = new AdapterRegistry();
  const { manifest } = createFixtureManifest("fixture-a");
  const entry = registry.register(manifest);
  assert.equal(entry.id, "fixture-a");
  assert.equal(entry.state, AdapterState.REGISTERED);
  assert.deepEqual(entry.capabilities, ["fixture"]);
});

test("register rejects an invalid manifest deterministically", () => {
  const registry = new AdapterRegistry();
  assert.throws(() => registry.register({ id: "bad" }), AdapterManifestError);
});

test("register rejects a duplicate id", () => {
  const registry = new AdapterRegistry();
  registry.register(createFixtureManifest("fixture-a").manifest);
  assert.throws(() => registry.register(createFixtureManifest("fixture-a").manifest), DuplicateAdapterError);
});

test("get/start/stop/health on an unknown id throw UnknownAdapterError", async () => {
  const registry = new AdapterRegistry();
  assert.throws(() => registry.get("missing"), UnknownAdapterError);
  await assert.rejects(() => registry.start("missing"), UnknownAdapterError);
  await assert.rejects(() => registry.stop("missing"), UnknownAdapterError);
  await assert.rejects(() => registry.health("missing"), UnknownAdapterError);
});

test("two adapters coexist and shut down independently", async () => {
  const registry = new AdapterRegistry();
  const a = createFixtureManifest("fixture-a");
  const b = createFixtureManifest("fixture-b");
  registry.register(a.manifest);
  registry.register(b.manifest);

  await registry.start("fixture-a");
  await registry.start("fixture-b");
  assert.equal(registry.get("fixture-a").state, AdapterState.RUNNING);
  assert.equal(registry.get("fixture-b").state, AdapterState.RUNNING);
  assert.equal(a.calls.started, 1);
  assert.equal(b.calls.started, 1);

  await registry.stop("fixture-a");
  assert.equal(registry.get("fixture-a").state, AdapterState.STOPPED);
  assert.equal(a.calls.stopped, 1);
  // fixture-b was never asked to stop and keeps running.
  assert.equal(registry.get("fixture-b").state, AdapterState.RUNNING);
  assert.equal(b.calls.stopped, 0);

  await registry.stop("fixture-b");
  assert.equal(registry.get("fixture-b").state, AdapterState.STOPPED);
});

test("a failing adapter start is isolated and does not affect a healthy sibling", async () => {
  const registry = new AdapterRegistry();
  const healthy = createFixtureManifest("fixture-healthy");
  registry.register(healthy.manifest);
  registry.register(createFailingFixtureManifest("fixture-broken", "spawn failed"));

  const healthyResult = await registry.start("fixture-healthy");
  const brokenResult = await registry.start("fixture-broken");

  assert.equal(healthyResult.state, AdapterState.RUNNING);
  assert.equal(brokenResult.state, AdapterState.ERRORED);
  assert.equal(brokenResult.error, "spawn failed");
  // the failure must not have propagated into the sibling's own state.
  assert.equal(registry.get("fixture-healthy").state, AdapterState.RUNNING);
});

test("list reports every registered adapter regardless of lifecycle state", async () => {
  const registry = new AdapterRegistry();
  registry.register(createFixtureManifest("fixture-a").manifest);
  registry.register(createFailingFixtureManifest("fixture-broken"));
  await registry.start("fixture-broken");

  const ids = registry.list().map((entry) => entry.id).sort();
  assert.deepEqual(ids, ["fixture-a", "fixture-broken"]);
});

test("health is normalized the same way regardless of transport kind", async () => {
  const registry = new AdapterRegistry();
  const { manifest } = createFixtureManifest("fixture-a");
  registry.register(manifest);

  const beforeStart = await registry.health("fixture-a");
  assert.equal(beforeStart.ok, false);
  assert.equal(beforeStart.state, AdapterState.REGISTERED);

  await registry.start("fixture-a");
  const afterStart = await registry.health("fixture-a");
  assert.equal(afterStart.ok, true);
  assert.equal(afterStart.state, AdapterState.RUNNING);
  assert.equal(afterStart.detail.ok, true);
});

test("health reflects an adapter's own health() reporting unhealthy while running", async () => {
  const registry = new AdapterRegistry();
  const { manifest } = createFixtureManifest("fixture-a", { health: async () => ({ ok: false, detail: "degraded" }) });
  registry.register(manifest);
  await registry.start("fixture-a");

  const health = await registry.health("fixture-a");
  assert.equal(health.state, AdapterState.RUNNING);
  assert.equal(health.ok, false);
});

test("tools() delegates discovery to the adapter and defaults to empty", async () => {
  const registry = new AdapterRegistry();
  const { manifest } = createFixtureManifest("fixture-a");
  registry.register(manifest);
  assert.deepEqual(await registry.tools("fixture-a"), [{ name: "fixture-a_tool" }]);

  registry.register(createFailingFixtureManifest("fixture-broken"));
  assert.deepEqual(await registry.tools("fixture-broken"), []);
});
