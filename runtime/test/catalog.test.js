import test from "node:test";
import assert from "node:assert/strict";
import { AdapterState } from "@majiwari/registry";
import { AdapterRegistry } from "@majiwari/registry";
import { createConfiguredManifests, TRUSTED_RESIDENT_CATALOG } from "../src/catalog.js";

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
