import test from "node:test";
import assert from "node:assert/strict";
import { AdapterState } from "@majiwari/registry";
import { AdapterRegistry } from "@majiwari/registry";
import { createConfiguredManifests, TRUSTED_RESIDENT_ADAPTER_IDS, TRUSTED_RESIDENT_CATALOG } from "../src/catalog.js";

test("a resident 'mottainai' config for open-code-review builds a managed, target-aware manifest", async () => {
  const [{ manifest }] = createConfiguredManifests({
    version: 1,
    adapters: { "open-code-review": { enabled: true, mottainai: {} } }
  });

  assert.equal(manifest.id, "open-code-review");
  // Managed mode (#29): the manifest exposes the generic targetProvider
  // capability instead of being bound to one repo for its whole lifetime.
  assert.equal(typeof manifest.targetProvider?.list, "function");
  assert.equal(typeof manifest.targetProvider?.resolve, "function");

  const registry = new AdapterRegistry();
  registry.register(manifest);
  const started = await registry.start("open-code-review");
  assert.equal(started.state, AdapterState.RUNNING, started.error);
  await registry.stop("open-code-review");
});

test("inari fails closed when given a 'mottainai' resident config -- it remains a single-repository adapter", () => {
  assert.throws(() => TRUSTED_RESIDENT_CATALOG.inari({ id: "inari", mottainai: {} }), /does not support the resident "mottainai" config/);
});

test("open-code-review 'mottainai' config takes precedence and never falls back to repo/targets construction", () => {
  const manifest = TRUSTED_RESIDENT_CATALOG["open-code-review"]({ id: "open-code-review", mottainai: {}, repo: undefined, targets: undefined });
  assert.equal(manifest.id, "open-code-review");
  assert.equal(typeof manifest.targetProvider?.resolve, "function");
});

test("the trusted catalog includes the 'mottainai' gateway adapter id (#56)", () => {
  assert.deepEqual(TRUSTED_RESIDENT_ADAPTER_IDS, ["open-code-review", "inari", "mottainai"]);
  assert.equal(typeof TRUSTED_RESIDENT_CATALOG.mottainai, "function");
});

test("a resident 'mottainai' config builds the trusted Mottainai gateway-adapter manifest and passes 'config' through as the launch selector", async () => {
  const [{ manifest }] = createConfiguredManifests({
    version: 1,
    adapters: { mottainai: { enabled: true } }
  });

  assert.equal(manifest.id, "mottainai");
  assert.equal(manifest.transport.kind, "stdio");
  // No Mottainai-specific health() is invented at this composition edge --
  // the generic registry lifecycle state is the adapter's own health
  // signal, same as its manifest declares (adapters/mottainai/src/manifest.js).
  assert.equal(manifest.health, undefined);

  const registry = new AdapterRegistry();
  registry.register(manifest);
  const started = await registry.start("mottainai");
  // No real "mottainai-mcp" binary is installed in this test environment:
  // startup fails deterministically (ERRORED), isolated to this one
  // adapter's own registry entry, exactly as #56 requires -- it never
  // throws out of the resident catalog/registry contract.
  assert.equal(started.state, AdapterState.ERRORED);
  assert.ok(started.error);
});
