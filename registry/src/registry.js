import { validateManifest } from "./manifest.js";

export const AdapterState = Object.freeze({
  REGISTERED: "registered",
  STARTING: "starting",
  RUNNING: "running",
  STOPPING: "stopping",
  STOPPED: "stopped",
  ERRORED: "errored"
});

export class DuplicateAdapterError extends Error {
  constructor(id) {
    super(`adapter "${id}" is already registered`);
    this.name = "DuplicateAdapterError";
  }
}

export class UnknownAdapterError extends Error {
  constructor(id) {
    super(`no adapter registered with id "${id}"`);
    this.name = "UnknownAdapterError";
  }
}

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}

function summarize(entry) {
  return {
    id: entry.manifest.id,
    version: entry.manifest.version,
    displayName: entry.manifest.displayName,
    transportKind: entry.manifest.transport.kind,
    capabilities: entry.manifest.capabilities ?? [],
    state: entry.state,
    error: entry.error,
    startedAt: entry.startedAt,
    stoppedAt: entry.stoppedAt
  };
}

/**
 * Adapter-agnostic runtime registry. Owns manifest validation, adapter
 * identity uniqueness, lifecycle transitions, and normalized health/status
 * reporting. Never inspects or branches on what an adapter's tools mean --
 * that stays owned by the adapter's own MCP surface.
 */
export class AdapterRegistry {
  #adapters = new Map();

  register(manifest) {
    const normalized = validateManifest(manifest);
    if (this.#adapters.has(normalized.id)) {
      throw new DuplicateAdapterError(normalized.id);
    }
    this.#adapters.set(normalized.id, {
      manifest: normalized,
      state: AdapterState.REGISTERED,
      handle: undefined,
      // Whether a resource (process/connection) is currently acquired and
      // therefore actually needs a stop/disconnect call to release. This is
      // tracked separately from `state` because ERRORED alone cannot tell a
      // failed start (nothing acquired) apart from a failed stop (resource
      // still held) -- see start()/stop() below.
      acquired: false,
      error: undefined,
      startedAt: undefined,
      stoppedAt: undefined
    });
    return this.get(normalized.id);
  }

  list() {
    return [...this.#adapters.keys()].map((id) => this.get(id));
  }

  get(id) {
    return summarize(this.#requireEntry(id));
  }

  /**
   * Start one adapter. A failure inside the adapter's own transport (a
   * rejected start(), a thrown error) is captured on that adapter's entry
   * as ERRORED and never propagates -- it cannot crash or block any other
   * registered adapter. Only a registry usage error (unknown id) throws.
   *
   * A resource is marked `acquired` only once transport.start()/connect()
   * has actually resolved, so a failed start never looks, to stop(), like
   * something that needs releasing.
   */
  async start(id) {
    const entry = this.#requireEntry(id);
    if (entry.state === AdapterState.RUNNING || entry.state === AdapterState.STARTING || entry.acquired) {
      // Already running/starting, or a prior stop() failed to release an
      // acquired resource -- refuse to acquire a second one on top of it.
      return summarize(entry);
    }
    entry.state = AdapterState.STARTING;
    entry.error = undefined;
    try {
      const handle = entry.manifest.transport.kind === "stdio" ? await entry.manifest.transport.start() : await entry.manifest.transport.connect?.();
      entry.handle = handle;
      entry.acquired = true;
      entry.state = AdapterState.RUNNING;
      entry.startedAt = new Date().toISOString();
    } catch (error) {
      entry.state = AdapterState.ERRORED;
      entry.acquired = false;
      entry.error = errorMessage(error);
    }
    return summarize(entry);
  }

  /**
   * Stop one adapter, independently of any other adapter's state.
   *
   * Cleanup eligibility is decided by `acquired`, not by `state`: ERRORED
   * covers both a failed start (nothing was ever acquired) and a failed
   * stop (the resource is still held). When nothing is acquired, stop()
   * is a safe no-op that never invokes transport.stop()/disconnect() with
   * no real handle behind it. When a resource is held, stop() always
   * attempts release and is safely retryable after a prior failure --
   * `acquired` only clears once release actually succeeds.
   */
  async stop(id) {
    const entry = this.#requireEntry(id);
    if (entry.state !== AdapterState.RUNNING && entry.state !== AdapterState.ERRORED) {
      return summarize(entry);
    }
    if (!entry.acquired) {
      entry.state = AdapterState.STOPPED;
      entry.error = undefined;
      entry.stoppedAt = new Date().toISOString();
      entry.handle = undefined;
      return summarize(entry);
    }
    entry.state = AdapterState.STOPPING;
    try {
      const transport = entry.manifest.transport;
      if (transport.kind === "stdio") {
        await transport.stop?.(entry.handle);
      } else {
        await transport.disconnect?.(entry.handle);
      }
      entry.acquired = false;
      entry.state = AdapterState.STOPPED;
      entry.error = undefined;
      entry.stoppedAt = new Date().toISOString();
      entry.handle = undefined;
    } catch (error) {
      // Resource is still held (acquired stays true): a later stop() will
      // retry release instead of silently treating it as already gone.
      entry.state = AdapterState.ERRORED;
      entry.error = errorMessage(error);
    }
    return summarize(entry);
  }

  /**
   * Normalized health/status for one adapter. Lifecycle state is always
   * the base signal; an adapter-declared health() is consulted only while
   * RUNNING, and its result is folded into the same shape for every
   * adapter regardless of transport kind.
   */
  async health(id) {
    const entry = this.#requireEntry(id);
    const base = { id: entry.manifest.id, state: entry.state, ok: entry.state === AdapterState.RUNNING, error: entry.error, detail: undefined };
    if (entry.state !== AdapterState.RUNNING || typeof entry.manifest.health !== "function") {
      return base;
    }
    try {
      const detail = await entry.manifest.health();
      return { ...base, ok: detail?.ok !== false, detail };
    } catch (error) {
      return { ...base, ok: false, error: errorMessage(error) };
    }
  }

  /**
   * Tool discovery for one adapter, delegated entirely to the adapter's
   * own listTools(); the registry never inspects tool schemas or results.
   */
  async tools(id) {
    const entry = this.#requireEntry(id);
    if (typeof entry.manifest.listTools !== "function") return [];
    return entry.manifest.listTools();
  }

  #requireEntry(id) {
    const entry = this.#adapters.get(id);
    if (!entry) throw new UnknownAdapterError(id);
    return entry;
  }
}
