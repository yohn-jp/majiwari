import { MANIFEST_SCHEMA_VERSION, TARGET_PROVIDER_SCHEMA_VERSION } from "@majiwari/registry";

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

/**
 * A fixture whose listTools() rejects once started, for tool-discovery
 * failure-isolation tests. registry.tools() has no internal try/catch (see
 * registry/src/registry.js), so this is the one optional capability whose
 * failure the UI layer itself must contain.
 */
export function createToolDiscoveryFailureFixtureManifest(id, reason = "tool discovery unavailable") {
  return {
    schemaVersion: MANIFEST_SCHEMA_VERSION,
    id,
    version: "1.0.0",
    transport: {
      kind: "stdio",
      start: async () => ({ id }),
      stop: async () => {}
    },
    health: async () => ({ ok: true }),
    listTools: async () => {
      throw new Error(reason);
    }
  };
}

/**
 * A fixture whose health() rejects once started, for health
 * failure-isolation tests. registry.health() already catches a rejecting
 * health() itself and folds it into a normalized `{ ok: false, error }`
 * shape rather than throwing, so this proves that shape survives intact
 * through the UI's own projection/HTTP layers.
 */
export function createHealthFailureFixtureManifest(id, reason = "health check unavailable") {
  return {
    schemaVersion: MANIFEST_SCHEMA_VERSION,
    id,
    version: "1.0.0",
    transport: {
      kind: "stdio",
      start: async () => ({ id }),
      stop: async () => {}
    },
    health: async () => {
      throw new Error(reason);
    },
    listTools: async () => []
  };
}

/**
 * A minimal, spec-shaped target-provider contract (registry/src/
 * target-provider.js) whose four hooks are driven by the given overrides.
 * Used to build both a working target-provider fixture and one whose
 * list() rejects, for the generic target-provider projection and its
 * failure-isolation test respectively.
 */
export function createFixtureTargetProvider(overrides = {}) {
  return {
    schemaVersion: TARGET_PROVIDER_SCHEMA_VERSION,
    list: async () => [{ id: "target-a", kind: "fixture-target", displayName: "Target A" }],
    get: async (targetId) => ({ id: targetId, kind: "fixture-target" }),
    resolve: async (targetId) => ({ id: targetId, kind: "fixture-target", descriptor: { internal: true } }),
    invalidate: async () => {},
    ...overrides
  };
}
