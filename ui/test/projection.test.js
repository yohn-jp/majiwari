import test from "node:test";
import assert from "node:assert/strict";
import { AdapterRegistry, UnknownAdapterError } from "@majiwari/registry";
import { projectAdapterDetail, projectAdapterList } from "../src/projection.js";
import { createFailingFixtureManifest, createFixtureManifest } from "./fixtures/fixture-adapter.js";

test("projectAdapterList reflects every registered adapter with no adapter-specific branching", () => {
  const registry = new AdapterRegistry();
  registry.register(createFixtureManifest("fixture-a"));
  registry.register(createFixtureManifest("fixture-b"));

  const ids = projectAdapterList(registry).map((adapter) => adapter.id).sort();
  assert.deepEqual(ids, ["fixture-a", "fixture-b"]);
});

test("projectAdapterDetail merges identity, tools, capabilities, and health", async () => {
  const registry = new AdapterRegistry();
  registry.register(createFixtureManifest("fixture-a"));
  await registry.start("fixture-a");

  const detail = await projectAdapterDetail(registry, "fixture-a");
  assert.equal(detail.id, "fixture-a");
  assert.equal(detail.version, "1.0.0");
  assert.deepEqual(detail.capabilities, ["fixture"]);
  assert.deepEqual(detail.tools, [{ name: "fixture-a_tool" }]);
  assert.equal(detail.health.ok, true);
});

test("projectAdapterDetail propagates UnknownAdapterError for an unregistered id", async () => {
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
});
