import test from "node:test";
import assert from "node:assert/strict";
import { AdapterManifestError } from "../src/manifest.js";
import { AdapterAcquiredError, AdapterRegistry, AdapterState, DuplicateAdapterError, UnknownAdapterError } from "../src/registry.js";
import { createFailingFixtureManifest, createFixtureManifest, createFlakyStopFixtureManifest } from "./fixtures/fixture-adapter.js";

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

test("get/start/stop/health/resource on an unknown id throw UnknownAdapterError", async () => {
  const registry = new AdapterRegistry();
  assert.throws(() => registry.get("missing"), UnknownAdapterError);
  await assert.rejects(() => registry.start("missing"), UnknownAdapterError);
  await assert.rejects(() => registry.stop("missing"), UnknownAdapterError);
  await assert.rejects(() => registry.health("missing"), UnknownAdapterError);
  assert.throws(() => registry.resource("missing"), UnknownAdapterError);
});

test("resource() exposes the acquired handle only once start() has resolved, and clears it after stop()", async () => {
  const registry = new AdapterRegistry();
  const { manifest } = createFixtureManifest("fixture-a");
  registry.register(manifest);

  assert.equal(registry.resource("fixture-a"), undefined);

  await registry.start("fixture-a");
  assert.deepEqual(registry.resource("fixture-a"), { id: "fixture-a", pid: 1 });

  await registry.stop("fixture-a");
  assert.equal(registry.resource("fixture-a"), undefined);
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
  registry.register(createFailingFixtureManifest("fixture-broken", "spawn failed").manifest);

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
  registry.register(createFailingFixtureManifest("fixture-broken").manifest);
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

  registry.register(createFailingFixtureManifest("fixture-broken").manifest);
  assert.deepEqual(await registry.tools("fixture-broken"), []);
});

test("a failed start followed by stop is a safe no-op and never invokes transport.stop()", async () => {
  const registry = new AdapterRegistry();
  const broken = createFailingFixtureManifest("fixture-broken", "spawn failed");
  registry.register(broken.manifest);

  const started = await registry.start("fixture-broken");
  assert.equal(started.state, AdapterState.ERRORED);
  assert.equal(broken.calls.started, 1);
  assert.equal(broken.calls.stopped, 0);

  const stopped = await registry.stop("fixture-broken");
  // A failed start never acquired a resource, so stop() must not invoke the
  // adapter's stop() on a handle that was never obtained.
  assert.equal(broken.calls.stopped, 0);
  assert.equal(stopped.state, AdapterState.STOPPED);
  assert.equal(stopped.error, undefined);
});

test("a failed stop leaves the resource held and is safely retryable", async () => {
  const registry = new AdapterRegistry();
  const flaky = createFlakyStopFixtureManifest("fixture-flaky", 1);
  registry.register(flaky.manifest);

  await registry.start("fixture-flaky");
  assert.equal(registry.get("fixture-flaky").state, AdapterState.RUNNING);

  const firstStop = await registry.stop("fixture-flaky");
  assert.equal(firstStop.state, AdapterState.ERRORED);
  assert.equal(flaky.calls.stopped, 1);

  // Retrying stop() must attempt release again -- the resource is still
  // held after a failed cleanup, unlike a failed start.
  const secondStop = await registry.stop("fixture-flaky");
  assert.equal(secondStop.state, AdapterState.STOPPED);
  assert.equal(flaky.calls.stopped, 2);
  assert.equal(secondStop.error, undefined);

  // Once actually released, a further stop() is a no-op that does not
  // re-invoke transport.stop() -- no repeated/invalid cleanup calls.
  await registry.stop("fixture-flaky");
  assert.equal(flaky.calls.stopped, 2);
});

test("unregister() clears a never-started entry so the same id can be registered again", () => {
  const registry = new AdapterRegistry();
  registry.register(createFixtureManifest("fixture-a").manifest);

  registry.unregister("fixture-a");
  assert.throws(() => registry.get("fixture-a"), UnknownAdapterError);

  const entry = registry.register(createFixtureManifest("fixture-a").manifest);
  assert.equal(entry.id, "fixture-a");
});

test("unregister() clears a failed start (nothing acquired), unblocking a retry of the same id", async () => {
  const registry = new AdapterRegistry();
  registry.register(createFailingFixtureManifest("fixture-broken", "boom").manifest);
  const started = await registry.start("fixture-broken");
  assert.equal(started.state, AdapterState.ERRORED);

  registry.unregister("fixture-broken");
  assert.throws(() => registry.get("fixture-broken"), UnknownAdapterError);

  // A duplicate-id collision no longer blocks retrying the same id.
  const retried = registry.register(createFixtureManifest("fixture-broken").manifest);
  assert.equal(retried.id, "fixture-broken");
  assert.equal((await registry.start("fixture-broken")).state, AdapterState.RUNNING);
});

test("unregister() refuses to clear an entry whose resource is still acquired", async () => {
  const registry = new AdapterRegistry();
  registry.register(createFixtureManifest("fixture-a").manifest);
  await registry.start("fixture-a");

  assert.throws(() => registry.unregister("fixture-a"), AdapterAcquiredError);
  // The entry, and its acquired resource, are untouched by the refusal.
  assert.equal(registry.get("fixture-a").state, AdapterState.RUNNING);

  await registry.stop("fixture-a");
  registry.unregister("fixture-a");
  assert.throws(() => registry.get("fixture-a"), UnknownAdapterError);
});

test("unregister() on an unknown id throws UnknownAdapterError", () => {
  const registry = new AdapterRegistry();
  assert.throws(() => registry.unregister("missing"), UnknownAdapterError);
});

test("start() refuses to re-acquire while a failed stop still holds the resource", async () => {
  const registry = new AdapterRegistry();
  const flaky = createFlakyStopFixtureManifest("fixture-flaky", 1);
  registry.register(flaky.manifest);

  await registry.start("fixture-flaky");
  await registry.stop("fixture-flaky"); // fails once by design, resource still held
  assert.equal(registry.get("fixture-flaky").state, AdapterState.ERRORED);
  assert.equal(flaky.calls.started, 1);

  // start() must not acquire a second resource on top of the one still
  // held by the failed stop -- that would leak the first handle.
  const retriedStart = await registry.start("fixture-flaky");
  assert.equal(flaky.calls.started, 1);
  assert.equal(retriedStart.state, AdapterState.ERRORED);

  // Releasing the held resource still works afterward.
  const stopped = await registry.stop("fixture-flaky");
  assert.equal(stopped.state, AdapterState.STOPPED);
  assert.equal(flaky.calls.stopped, 2);
});
