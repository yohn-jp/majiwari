import http from "node:http";
import { AdapterRegistry, AdapterState } from "@majiwari/registry";
import { createRegistryGateway } from "@majiwari/gateway";
import { createUiHandler } from "@majiwari/ui";
import { createConfiguredManifests, redactResidentError, TRUSTED_RESIDENT_CATALOG } from "./catalog.js";
import { parseResidentConfig } from "./config.js";

export const RESIDENT_LOOPBACK_HOST = "127.0.0.1";

export class ResidentRuntimeError extends Error {
  constructor(message, options) {
    super(message, options);
    this.name = "ResidentRuntimeError";
  }
}

function errorText(error) {
  return error instanceof Error ? error.message : String(error);
}

function listen(server, port) {
  return new Promise((resolve, reject) => {
    const onError = (error) => {
      server.off("error", onError);
      reject(error);
    };
    server.once("error", onError);
    try {
      server.listen(port, RESIDENT_LOOPBACK_HOST, () => {
        server.off("error", onError);
        resolve(server);
      });
    } catch (error) {
      server.off("error", onError);
      reject(error);
    }
  });
}

function beginClose(server) {
  if (!server || !server.listening || typeof server.close !== "function") {
    return { promise: Promise.resolve(), forceClose: () => {} };
  }

  let settled = false;
  let resolveClosed;
  const promise = new Promise((resolve) => {
    resolveClosed = () => {
      if (settled) return;
      settled = true;
      resolve();
    };
  });

  try {
    server.close(() => resolveClosed());
  } catch {
    resolveClosed();
  }

  return {
    promise,
    forceClose: () => {
      try {
        server.closeAllConnections?.();
      } catch {
        // The listener is already on its way down; cleanup remains best effort.
      }
    }
  };
}

/**
 * One resident process. Config validation occurs in the constructor before
 * any server, registry, gateway, adapter factory, or child-process work.
 */
export class ResidentRuntime {
  #config;
  #catalog;
  #registryFactory;
  #serverFactory;
  #gatewayFactory;
  #uiFactory;
  #state = "created";
  #startPromise;
  #cleanupPromise;
  #registry;
  #gateway;
  #server;
  #ingressHandler;
  #registeredIds = [];
  #attachedIds = new Set();
  #attachFailures = new Map();
  #shutdownErrors = [];

  constructor(rawConfig, options = {}) {
    // Keep this first: invalid config must not even construct an ingress.
    this.#config = parseResidentConfig(rawConfig);
    this.#catalog = options.catalog ?? TRUSTED_RESIDENT_CATALOG;
    this.#registryFactory = options.registryFactory ?? (() => new AdapterRegistry());
    this.#serverFactory = options.serverFactory ?? ((handler) => http.createServer(handler));
    this.#gatewayFactory = options.gatewayFactory ?? createRegistryGateway;
    this.#uiFactory = options.uiFactory ?? createUiHandler;
    for (const [name, value] of Object.entries({
      registryFactory: this.#registryFactory,
      serverFactory: this.#serverFactory,
      gatewayFactory: this.#gatewayFactory,
      uiFactory: this.#uiFactory
    })) {
      if (typeof value !== "function") throw new TypeError(`${name} must be a function`);
    }
  }

  get state() {
    return this.#state;
  }

  get registry() {
    return this.#registry;
  }

  get gateway() {
    return this.#gateway;
  }

  get server() {
    return this.#server;
  }

  get port() {
    const address = this.#server?.address?.();
    return typeof address === "object" && address ? address.port : undefined;
  }

  get attachedAdapterIds() {
    return [...this.#attachedIds];
  }

  get attachFailures() {
    return new Map(this.#attachFailures);
  }

  get shutdownErrors() {
    return [...this.#shutdownErrors];
  }

  async start() {
    if (this.#state === "running") return this;
    if (this.#state === "starting") return this.#startPromise;
    if (this.#state === "stopped" || this.#state === "failed") {
      throw new ResidentRuntimeError(`resident runtime cannot start from state ${this.#state}`);
    }

    this.#state = "starting";
    this.#startPromise = this.#startInternal();
    return this.#startPromise;
  }

  async #startInternal() {
    const repos = Object.values(this.#config.adapters)
      .filter((adapter) => adapter?.enabled)
      .flatMap((adapter) => {
        if ("targets" in adapter) return adapter.targets.map((target) => target.repo);
        if ("mottainai" in adapter) return adapter.mottainai.cwd ? [adapter.mottainai.cwd] : [];
        // The trusted `mottainai` adapter id (#56) has no configured
        // repository -- only its optional `config` file path.
        if ("config" in adapter) return adapter.config ? [adapter.config] : [];
        return [adapter.repo];
      });

    try {
      this.#registry = this.#registryFactory();
      if (!this.#registry) throw new ResidentRuntimeError("resident runtime registry factory returned nothing");

      let gateway;
      let ui;
      this.#ingressHandler = async (req, res) => {
        try {
          if (await gateway.handle(req, res)) return;
          if (await ui(req, res)) return;
          if (!res.writableEnded && !res.headersSent) res.writeHead(404).end();
        } catch {
          if (!res.headersSent) res.writeHead(500).end();
          else if (!res.writableEnded) res.destroy();
        }
      };
      this.#server = this.#serverFactory(this.#ingressHandler);
      if (!this.#server) throw new ResidentRuntimeError("resident runtime server factory returned nothing");

      // Runtime owns the request listener and dispatches gateway.handle()
      // before the UI handler. Do not also mount gateway on the same server:
      // two request listeners would race to write one response.
      gateway = await this.#gatewayFactory({ registry: this.#registry });
      if (!gateway || typeof gateway.handle !== "function" || typeof gateway.close !== "function") {
        throw new ResidentRuntimeError("resident runtime gateway factory returned an invalid gateway");
      }
      this.#gateway = gateway;
      ui = this.#uiFactory(this.#registry, { basePath: "/ui" });
      if (typeof ui !== "function") throw new ResidentRuntimeError("resident runtime UI factory returned an invalid handler");

      // Bind before starting any adapter. An occupied port therefore cannot
      // leave a child process or acquired registry resource behind.
      await listen(this.#server, this.#config.port);

      const configured = createConfiguredManifests(this.#config, { catalog: this.#catalog });
      this.#registeredIds = configured.map(({ id }) => id);
      for (const { id, manifest } of configured) {
        this.#registry.register(manifest);
      }

      // Register all desired adapters before attempting any start. A start
      // failure is captured by AdapterRegistry and cannot block its sibling.
      for (const id of this.#registeredIds) {
        await this.#registry.start(id);
      }

      // Publication is lifecycle-neutral: only entries that reached RUNNING
      // are attached, and an attach failure leaves the registry entry intact.
      for (const id of this.#registeredIds) {
        if (this.#registry.get(id).state !== AdapterState.RUNNING) continue;
        try {
          await this.#gateway.attach(id);
          this.#attachedIds.add(id);
        } catch (error) {
          this.#attachFailures.set(id, errorText(redactResidentError(error, repos)));
        }
      }

      this.#state = "running";
      return this;
    } catch (error) {
      await this.#cleanupResources();
      this.#state = "failed";
      throw new ResidentRuntimeError(`resident runtime startup failed: ${errorText(redactResidentError(error, repos))}`);
    }
  }

  async shutdown() {
    if (this.#state === "failed" || this.#state === "stopped") return;
    if (this.#cleanupPromise) return this.#cleanupPromise;

    this.#cleanupPromise = (async () => {
      if (this.#startPromise && this.#state === "starting") {
        try {
          await this.#startPromise;
        } catch {
          return;
        }
      }
      await this.#cleanupResources();
      this.#state = "stopped";
    })();
    return this.#cleanupPromise;
  }

  async close() {
    return this.shutdown();
  }

  async #cleanupResources() {
    // Startup failure calls this method before #cleanupPromise is assigned;
    // normal shutdown assigns it first. The private guard below is the actual
    // once-only boundary for adapter/gateway/listener cleanup.
    if (this.#resourcesCleaned) return;
    this.#resourcesCleaned = true;

    const closeIngress = beginClose(this.#server);
    if (this.#server && this.#ingressHandler) {
      this.#server.off?.("request", this.#ingressHandler);
    }

    try {
      await this.#gateway?.close?.();
    } catch (error) {
      this.#shutdownErrors.push(`gateway: ${errorText(error)}`);
    }

    closeIngress.forceClose();
    await closeIngress.promise;

    for (const id of [...this.#registeredIds].reverse()) {
      try {
        await this.#registry?.stop(id);
      } catch (error) {
        this.#shutdownErrors.push(`${id}: ${errorText(error)}`);
      }
    }
  }

  #resourcesCleaned = false;
}

/**
 * Install one idempotent SIGINT/SIGTERM shutdown path. `handle` is returned
 * as a deterministic test seam; the CLI uses process event listeners.
 */
export function installResidentSignalHandlers(runtime, { processRef = process, exit = (code) => processRef.exit(code) } = {}) {
  let shutdownPromise;
  const handle = () => {
    shutdownPromise ??= runtime.shutdown().then(
      () => exit(0),
      () => exit(1)
    );
    return shutdownPromise;
  };
  processRef.on("SIGINT", handle);
  processRef.on("SIGTERM", handle);

  return {
    handle,
    get promise() {
      return shutdownPromise;
    },
    dispose() {
      processRef.off?.("SIGINT", handle);
      processRef.off?.("SIGTERM", handle);
    }
  };
}

export function configuredResidentAdapterIds(config) {
  return Object.entries(parseResidentConfig(config).adapters)
    .filter(([, adapter]) => adapter?.enabled)
    .map(([id]) => id);
}

export function createResidentRuntime(config, options) {
  return new ResidentRuntime(config, options);
}
