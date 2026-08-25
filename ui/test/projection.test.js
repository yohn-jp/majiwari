import test from "node:test";
import assert from "node:assert/strict";
import { AdapterRegistry, UnknownAdapterError } from "@majiwari/registry";
import { projectAdapterDetail, projectAdapterList } from "../src/projection.js";
import {
  createFailingFixtureManifest,
  createFixtureManifest,
  createFixtureTargetProvider,
  createHealthFailureFixtureManifest,
  createToolDiscoveryFailureFixtureManifest
} from "./fixtures/fixture-adapter.js";

test("projectAdapterList reflects every registered adapter with no adapter-specific branching", () => {
  const registry = new AdapterRegistry();
  registry.register(createFixtureManifest("fixture-a"));
  registry.register(createFixtureManifest("fixture-b"));
  registry.register(createFixtureManifest("fixture-c"));

  const ids = projectAdapterList(registry)
    .map((adapter) => adapter.id)
    .sort();
  assert.deepEqual(ids, ["fixture-a", "fixture-b", "fixture-c"]);
});

test("projectAdapterDetail merges identity, tools, capabilities, and health through the canonical registry API", async () => {
  const registry = new AdapterRegistry();
  registry.register(createFixtureManifest("fixture-a"));
  await registry.start("fixture-a");

  const detail = await projectAdapterDetail(registry, "fixture-a");
  assert.equal(detail.id, "fixture-a");
  assert.equal(detail.version, "1.0.0");
  assert.deepEqual(detail.capabilities, ["fixture"]);
  assert.deepEqual(detail.tools, { ok: true, items: [{ name: "fixture-a_tool" }] });
  assert.equal(detail.health.ok, true);
});

test("an adapter that declares no optional capabilities still renders a complete, non-error detail", async () => {
  const registry = new AdapterRegistry();
  registry.register(createFixtureManifest("fixture-bare", { listTools: undefined, health: undefined, capabilities: undefined }));
  await registry.start("fixture-bare");

  const detail = await projectAdapterDetail(registry, "fixture-bare");
  assert.deepEqual(detail.capabilities, []);
  assert.deepEqual(detail.tools, { ok: true, items: [] });
  assert.equal(detail.health.ok, true);
  assert.deepEqual(detail.targets, { supported: false, ok: true, items: [] });
});

test("projectAdapterDetail propagates UnknownAdapterError for an unregistered id, without leaking internal detail", async () => {
  const registry = new AdapterRegistry();
  await assert.rejects(() => projectAdapterDetail(registry, "does-not-exist"), UnknownAdapterError);
});

test("a failed adapter's state is represented accurately without affecting a healthy sibling", async () => {
  const registry = new AdapterRegistry();
  registry.register(createFixtureManifest("fixture-healthy"));
  registry.register(createFailingFixtureManifest("fixture-broken", "spawn failed"));
  await registry.start("fixture-healthy");
  await registry.start("fixture-broken");

  const list = projectAdapterList(registry);
  const healthy = list.find((adapter) => adapter.id === "fixture-healthy");
  const broken = list.find((adapter) => adapter.id === "fixture-broken");

  assert.equal(healthy.state, "running");
  assert.equal(broken.state, "errored");
  assert.equal(broken.error, "spawn failed");

  const healthyDetail = await projectAdapterDetail(registry, "fixture-healthy");
  assert.equal(healthyDetail.health.ok, true);
});

test("a rejecting listTools() is isolated to the tools section and never fails the whole detail", async () => {
  const registry = new AdapterRegistry();
  registry.register(createToolDiscoveryFailureFixtureManifest("fixture-tools-broken", "listTools boom"));
  registry.register(createFixtureManifest("fixture-sibling"));
  await registry.start("fixture-tools-broken");
  await registry.start("fixture-sibling");

  const detail = await projectAdapterDetail(registry, "fixture-tools-broken");
  assert.equal(detail.id, "fixture-tools-broken");
  assert.equal(detail.tools.ok, false);
  assert.match(detail.tools.error, /listTools boom/);
  assert.equal(detail.health.ok, true);

  const siblingDetail = await projectAdapterDetail(registry, "fixture-sibling");
  assert.equal(siblingDetail.tools.ok, true);
});

test("a rejecting health() is isolated to the health section and never fails the whole detail", async () => {
  const registry = new AdapterRegistry();
  registry.register(createHealthFailureFixtureManifest("fixture-health-broken", "health boom"));
  registry.register(createFixtureManifest("fixture-sibling"));
  await registry.start("fixture-health-broken");
  await registry.start("fixture-sibling");

  const detail = await projectAdapterDetail(registry, "fixture-health-broken");
  assert.equal(detail.id, "fixture-health-broken");
  assert.equal(detail.health.ok, false);
  assert.match(detail.health.error, /health boom/);
  assert.deepEqual(detail.tools, { ok: true, items: [] });

  const siblingDetail = await projectAdapterDetail(registry, "fixture-sibling");
  assert.equal(siblingDetail.health.ok, true);
});

test("generic target-provider projection exposes only the public target shape, never a resolved/internal descriptor", async () => {
  const registry = new AdapterRegistry();
  const provider = createFixtureTargetProvider();
  registry.register(createFixtureManifest("fixture-targets", { targetProvider: provider }));
  await registry.start("fixture-targets");

  const detail = await projectAdapterDetail(registry, "fixture-targets");
  assert.equal(detail.targets.supported, true);
  assert.equal(detail.targets.ok, true);
  assert.deepEqual(detail.targets.items, [{ id: "target-a", kind: "fixture-target", displayName: "Target A" }]);
  for (const target of detail.targets.items) {
    assert.ok(!("descriptor" in target), "projected target must never carry the internal resolved descriptor");
  }
});

test("a rejecting target-provider list() is isolated to the targets section and never fails the whole detail", async () => {
  const registry = new AdapterRegistry();
  const provider = createFixtureTargetProvider({
    list: async () => {
      throw new Error("target discovery boom");
    }
  });
  registry.register(createFixtureManifest("fixture-targets-broken", { targetProvider: provider }));
  registry.register(createFixtureManifest("fixture-sibling"));
  await registry.start("fixture-targets-broken");
  await registry.start("fixture-sibling");

  const detail = await projectAdapterDetail(registry, "fixture-targets-broken");
  assert.equal(detail.targets.supported, true);
  assert.equal(detail.targets.ok, false);
  assert.match(detail.targets.error, /target discovery boom/);
  assert.equal(detail.health.ok, true);

  const siblingDetail = await projectAdapterDetail(registry, "fixture-sibling");
  assert.deepEqual(siblingDetail.targets, { supported: false, ok: true, items: [] });
});
