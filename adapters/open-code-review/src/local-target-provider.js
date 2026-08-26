import path from "node:path";
import { TARGET_PROVIDER_SCHEMA_VERSION, TargetNotFoundError, TargetUnavailableError } from "@majiwari/registry";

function toPublic({ id, kind, displayName, metadata }) {
  return {
    id,
    ...(kind !== undefined && { kind }),
    ...(displayName !== undefined && { displayName }),
    ...(metadata !== undefined && { metadata })
  };
}

/**
 * A static, in-memory @majiwari/registry target provider mapping opaque
 * target ids to absolute repository/worktree roots. This is the
 * "fixture/local provider" #29 uses to prove OCR's target-provider
 * authority end to end (one manifest, many managed targets, no restart).
 * Dynamic discovery (Mottainai sessions, #30) is a separate, later provider
 * behind this same contract -- nothing here knows or cares what a target
 * means beyond "an absolute repository root".
 *
 * `resolve()` is the only hook that ever returns `descriptor` (here,
 * `{ repoRoot }`); `list()`/`get()` stay on the public projection, matching
 * the registry's own list/get-vs-resolve boundary.
 */
export function createLocalTargetProvider(entries = []) {
  const targets = new Map();
  for (const entry of entries) {
    if (!entry || typeof entry.id !== "string" || entry.id.length === 0) {
      throw new Error("local target provider entries require a non-empty id");
    }
    if (typeof entry.repoRoot !== "string" || entry.repoRoot.length === 0 || !path.isAbsolute(entry.repoRoot)) {
      throw new Error(`local target provider entry "${entry.id}" requires an absolute repoRoot`);
    }
    targets.set(entry.id, entry);
  }
  const unavailable = new Set();

  return {
    schemaVersion: TARGET_PROVIDER_SCHEMA_VERSION,
    async list() {
      return [...targets.values()].filter((entry) => !unavailable.has(entry.id)).map(toPublic);
    },
    async get(id) {
      if (unavailable.has(id)) throw new TargetUnavailableError(id);
      const entry = targets.get(id);
      if (!entry) throw new TargetNotFoundError(id);
      return toPublic(entry);
    },
    async resolve(id) {
      if (unavailable.has(id)) throw new TargetUnavailableError(id);
      const entry = targets.get(id);
      if (!entry) throw new TargetNotFoundError(id);
      return { ...toPublic(entry), descriptor: { repoRoot: entry.repoRoot } };
    },
    async invalidate(id) {
      if (!targets.has(id)) throw new TargetNotFoundError(id);
      unavailable.add(id);
      return { id, invalidated: true };
    }
  };
}
