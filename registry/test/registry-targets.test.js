import test from "node:test";
import assert from "node:assert/strict";
import { AdapterManifestError } from "../src/manifest.js";
import { AdapterRegistry, TargetCapabilityUnsupportedError } from "../src/registry.js";
import { InvalidTargetIdError, TargetUnavailableError } from "../src/target-provider.js";
import { createFixtureManifest } from "./fixtures/fixture-adapter.js";
import { createFixtureTargetProvider } from "./fixtures/fixture-target-provider.js";

function seedTargets() {
  return [
    { id: "wt-a1", kind: "workspace", displayName: "Repo A", metadata: { branch: "main" }, descriptor: { absolutePath: "/srv/repo-a" } },
    { id: "wt-b1", kind: "workspace", displayName: "Repo B", descriptor: { absolutePath: "/srv/repo-b" } }
  ];
}

test("an adapter without targetProvider continues to function unchanged", async () => {
  const registry = new AdapterRegistry();
  const { manifest } = createFixtureManifest("fixture-a");
  registry.register(manifest);

  await registry.start("fixture-a");
  assert.equal(registry.get("fixture-a").state, "running");
  assert.deepEqual(await registry.tools("fixture-a"), [{ name: "fixture-a_tool" }]);

  await assert.rejects(() => registry.listTargets("fixture-a"), TargetCapabilityUnsupportedError);
  await assert.rejects(() => registry.getTarget("fixture-a", "wt-a1"), TargetCapabilityUnsupportedError);
  await assert.rejects(() => registry.resolveTarget("fixture-a", "wt-a1"), TargetCapabilityUnsupportedError);
  await assert.rejects(() => registry.invalidateTarget("fixture-a", "wt-a1"), TargetCapabilityUnsupportedError);
});

test("register rejects a targetProvider missing a required hook", () => {
  const registry = new AdapterRegistry();
  const { manifest } = createFixtureManifest("fixture-a", {
    targetProvider: { schemaVersion: "1", list: async () => [] }
  });
  assert.throws(() => registry.register(manifest), AdapterManifestError);
});

test("listTargets/getTarget/resolveTarget expose only public metadata; resolve adds the internal descriptor", async () => {
  const registry = new AdapterRegistry();
  const { provider } = createFixtureTargetProvider(seedTargets());
  const { manifest } = createFixtureManifest("fixture-targets", { targetProvider: provider });
  registry.register(manifest);

  const listed = await registry.listTargets("fixture-targets");
  assert.deepEqual(listed.map((t) => t.id).sort(), ["wt-a1", "wt-b1"]);
  assert.ok(listed.every((t) => !("descriptor" in t)));

  const got = await registry.getTarget("fixture-targets", "wt-a1");
  assert.equal(got.displayName, "Repo A");
  assert.ok(!("descriptor" in got));

  const resolved = await registry.resolveTarget("fixture-targets", "wt-a1");
  assert.deepEqual(resolved.descriptor, { absolutePath: "/srv/repo-a" });
});

test("invalidateTarget makes a target deterministically unavailable to get/resolve", async () => {
  const registry = new AdapterRegistry();
  const { provider } = createFixtureTargetProvider(seedTargets());
  const { manifest } = createFixtureManifest("fixture-targets", { targetProvider: provider });
  registry.register(manifest);

  await registry.invalidateTarget("fixture-targets", "wt-a1");

  await assert.rejects(() => registry.getTarget("fixture-targets", "wt-a1"), TargetUnavailableError);
  await assert.rejects(() => registry.resolveTarget("fixture-targets", "wt-a1"), TargetUnavailableError);

  const listed = await registry.listTargets("fixture-targets");
  assert.deepEqual(listed.map((t) => t.id), ["wt-b1"]);
});

test("a path-shaped target id is rejected before ever reaching the adapter's provider", async () => {
  const registry = new AdapterRegistry();
  const { provider, calls } = createFixtureTargetProvider(seedTargets());
  const { manifest } = createFixtureManifest("fixture-targets", { targetProvider: provider });
  registry.register(manifest);

  for (const bad of ["../../etc/passwd", "/etc/passwd", "wt-a1/../../etc/passwd"]) {
    await assert.rejects(() => registry.getTarget("fixture-targets", bad), InvalidTargetIdError);
    await assert.rejects(() => registry.resolveTarget("fixture-targets", bad), InvalidTargetIdError);
    await assert.rejects(() => registry.invalidateTarget("fixture-targets", bad), InvalidTargetIdError);
  }

  // The provider's own hooks were never invoked with the malicious id --
  // rejection happened entirely at the registry boundary.
  assert.equal(calls.get, 0);
  assert.equal(calls.resolve, 0);
  assert.equal(calls.invalidate, 0);
});
