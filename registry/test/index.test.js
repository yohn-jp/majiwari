import test from "node:test";
import assert from "node:assert/strict";
// Only the canonical `@majiwari/registry` public entrypoint (`src/index.js`,
// `main` in package.json) -- never a deep import into an internal module
// such as `../src/target-provider.js` -- so a consumer never needs to know
// that the target-provider contract lives in its own file.
import * as registryPublicApi from "../src/index.js";
import { createFixtureManifest } from "./fixtures/fixture-adapter.js";
import { createFixtureTargetProvider } from "./fixtures/fixture-target-provider.js";

test("manifest and registry exports are reachable through the canonical public entrypoint", () => {
  assert.equal(typeof registryPublicApi.validateManifest, "function");
  assert.equal(typeof registryPublicApi.AdapterRegistry, "function");
  assert.equal(typeof registryPublicApi.AdapterManifestError, "function");
  assert.equal(typeof registryPublicApi.TargetCapabilityUnsupportedError, "function");
});

test("target-provider contract types/schemas/helpers are reachable through the same canonical entrypoint", () => {
  assert.equal(registryPublicApi.TARGET_PROVIDER_SCHEMA_VERSION, "1");
  assert.equal(typeof registryPublicApi.targetIdSchema.parse, "function");
  assert.equal(typeof registryPublicApi.publicTargetSchema.parse, "function");
  assert.equal(typeof registryPublicApi.resolvedTargetSchema.parse, "function");
  assert.equal(typeof registryPublicApi.parseTargetId, "function");
  assert.equal(typeof registryPublicApi.validatePublicTarget, "function");
  assert.equal(typeof registryPublicApi.validateResolvedTarget, "function");
  assert.equal(typeof registryPublicApi.validateTargetProviderContract, "function");
  assert.equal(typeof registryPublicApi.TargetProviderError, "function");
  assert.equal(typeof registryPublicApi.TargetNotFoundError, "function");
  assert.equal(typeof registryPublicApi.TargetUnavailableError, "function");
  assert.equal(typeof registryPublicApi.InvalidTargetIdError, "function");
});

test("an end-to-end target-provider flow works using only the canonical entrypoint's exports", async () => {
  const { AdapterRegistry } = registryPublicApi;
  const registry = new AdapterRegistry();
  const { provider } = createFixtureTargetProvider([
    { id: "wt-a1", kind: "workspace", displayName: "Repo A", descriptor: { absolutePath: "/srv/repo-a" } }
  ]);
  const { manifest } = createFixtureManifest("fixture-targets", { targetProvider: provider });
  registry.register(manifest);

  const listed = await registry.listTargets("fixture-targets");
  assert.deepEqual(listed, [{ id: "wt-a1", kind: "workspace", displayName: "Repo A" }]);

  const resolved = await registry.resolveTarget("fixture-targets", "wt-a1");
  assert.deepEqual(resolved.descriptor, { absolutePath: "/srv/repo-a" });
});
