import { MANIFEST_SCHEMA_VERSION } from "../../src/manifest.js";

/**
 * Build a minimal, valid stdio-transport manifest for tests. Each fixture
 * tracks its own start/stop calls so tests can assert independence between
 * two coexisting adapters without a real child process.
 */
export function createFixtureManifest(id, overrides = {}) {
  const calls = { started: 0, stopped: 0 };
  return {
    manifest: {
      schemaVersion: MANIFEST_SCHEMA_VERSION,
      id,
      version: "1.0.0",
      displayName: `Fixture ${id}`,
      transport: {
        kind: "stdio",
        start: async () => {
          calls.started += 1;
          return { id, pid: calls.started };
        },
        stop: async () => {
          calls.stopped += 1;
        }
      },
      health: async () => ({ ok: true, detail: `${id} is healthy` }),
      listTools: async () => [{ name: `${id}_tool` }],
      capabilities: ["fixture"],
      ...overrides
    },
    calls
  };
}

/** A manifest whose transport.start() always rejects, for isolation tests. */
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
