import { TARGET_PROVIDER_SCHEMA_VERSION, TargetNotFoundError, TargetUnavailableError } from "../../src/target-provider.js";

function toPublic({ id, kind, displayName, metadata }) {
  return {
    id,
    ...(kind !== undefined && { kind }),
    ...(displayName !== undefined && { displayName }),
    ...(metadata !== undefined && { metadata })
  };
}

/**
 * In-memory fixture target provider. `seed` entries carry an internal
 * `descriptor` (e.g. a filesystem path) that only resolve() ever returns;
 * list()/get() strip it down to the public shape. Tracks call counts so
 * tests can prove a rejected (path-shaped) id never reaches these hooks.
 */
export function createFixtureTargetProvider(seed = []) {
  const targets = new Map(seed.map((entry) => [entry.id, entry]));
  const unavailable = new Set();
  const calls = { list: 0, get: 0, resolve: 0, invalidate: 0 };

  const provider = {
    schemaVersion: TARGET_PROVIDER_SCHEMA_VERSION,
    async list() {
      calls.list += 1;
      return [...targets.values()].filter((entry) => !unavailable.has(entry.id)).map(toPublic);
    },
    async get(id) {
      calls.get += 1;
      if (unavailable.has(id)) throw new TargetUnavailableError(id);
      const entry = targets.get(id);
      if (!entry) throw new TargetNotFoundError(id);
      return toPublic(entry);
    },
    async resolve(id) {
      calls.resolve += 1;
      if (unavailable.has(id)) throw new TargetUnavailableError(id);
      const entry = targets.get(id);
      if (!entry) throw new TargetNotFoundError(id);
      return { ...toPublic(entry), descriptor: entry.descriptor };
    },
    async invalidate(id) {
      calls.invalidate += 1;
      if (!targets.has(id)) throw new TargetNotFoundError(id);
      unavailable.add(id);
      return { id, invalidated: true };
    }
  };

  return { provider, targets, calls };
}
