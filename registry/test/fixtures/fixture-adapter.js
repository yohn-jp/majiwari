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

/**
 * A manifest whose transport.start() always rejects, for isolation tests.
 * Its stop() is tracked too, so tests can prove it is never invoked when
 * nothing was ever successfully acquired.
 */
export function createFailingFixtureManifest(id, reason = "boom") {
  const calls = { started: 0, stopped: 0 };
  return {
    manifest: {
      schemaVersion: MANIFEST_SCHEMA_VERSION,
      id,
      version: "1.0.0",
      transport: {
        kind: "stdio",
        start: async () => {
          calls.started += 1;
          throw new Error(reason);
        },
        stop: async () => {
          calls.stopped += 1;
        }
      }
    },
    calls
  };
}

/**
 * A manifest whose start() succeeds (acquiring a resource) but whose
 * stop() rejects the first `failTimes` calls before succeeding, for
 * failed-stop retry tests.
 */
export function createFlakyStopFixtureManifest(id, failTimes = 1, reason = "cleanup failed") {
  const calls = { started: 0, stopped: 0 };
  return {
    manifest: {
      schemaVersion: MANIFEST_SCHEMA_VERSION,
      id,
      version: "1.0.0",
      transport: {
        kind: "stdio",
        start: async () => {
          calls.started += 1;
          return { id, pid: calls.started };
        },
        stop: async () => {
          calls.stopped += 1;
          if (calls.stopped <= failTimes) throw new Error(reason);
        }
      }
    },
    calls
  };
}
