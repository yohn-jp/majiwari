import { MANIFEST_SCHEMA_VERSION } from "@majiwari/registry/manifest";

/**
 * Minimal valid stdio-transport fixture manifest for UI projection tests.
 * Mirrors the shape registry/test/fixtures/fixture-adapter.js uses, kept
 * local so this package's tests do not reach into another workspace's
 * test-only internals.
 */
export function createFixtureManifest(id, overrides = {}) {
  return {
    schemaVersion: MANIFEST_SCHEMA_VERSION,
    id,
    version: "1.0.0",
    displayName: `Fixture ${id}`,
    transport: {
      kind: "stdio",
      start: async () => ({ id }),
      stop: async () => {}
    },
    health: async () => ({ ok: true, detail: `${id} is healthy` }),
    listTools: async () => [{ name: `${id}_tool` }],
    capabilities: ["fixture"],
    ...overrides
  };
}

export function createFailingFixtureManifest(id, reason = "boom") {
  return {
    schemaVersion: MANIFEST_SCHEMA_VERSION,
    id,
    version: "1.0.0",
    transport: {
      kind: "stdio",
      start: async () => {
        throw new Error(reason);
      }
    }
  };
}
