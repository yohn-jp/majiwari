import { Server } from "@modelcontextprotocol/server";
import { AdapterState, ID_PATTERN, UnknownAdapterError } from "@majiwari/registry";
import { proxyServer, startHTTPServer } from "mcp-proxy";
import http from "node:http";
import net from "node:net";
import { toGatewayRoutableResource } from "./gateway-transport.js";

/** Public adapter route, bounded by the registry's own ID grammar. */
const ADAPTER_PATH = new RegExp(`^/mcp/(${ID_PATTERN.source.slice(1, -1)})$`);
const INTERNAL_BRIDGE_HOST = "127.0.0.1";

function matchAdapterPath(pathname) {
  const match = ADAPTER_PATH.exec(pathname);
  return match ? match[1] : undefined;
}

function isMcpNamespace(pathname) {
  return pathname === "/mcp" || pathname.startsWith("/mcp/");
}

function getFreePort(host) {
  return new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.on("error", reject);
    probe.listen(0, host, () => {
      const address = probe.address();
      const port = typeof address === "object" && address ? address.port : undefined;
      probe.close((error) => (error ? reject(error) : resolve(port)));
    });
  });
}

/** Start one loopback-only bridge for one already-acquired registry resource. */
async function startAdapterBridge({ registry, adapterId }) {
  const resource = toGatewayRoutableResource(registry.resource(adapterId), adapterId);
  const port = await getFreePort(INTERNAL_BRIDGE_HOST);
  const internal = await startHTTPServer({
    createServer: async () => {
      const session = new Server(resource.serverVersion, { capabilities: resource.serverCapabilities });
      await proxyServer({ client: resource.mcpClient, server: session, serverCapabilities: resource.serverCapabilities });
      return session;
    },
    host: INTERNAL_BRIDGE_HOST,
    port,
    sseEndpoint: null,
    streamEndpoint: "/mcp"
  });
  return { close: () => internal.close(), host: INTERNAL_BRIDGE_HOST, port };
}

/**
 * Handle only `/mcp` routes. Returning false lets a shared externally-owned
 * ingress dispatch `/ui/*` elsewhere and apply one final 404 to unrelated
 * paths. MCP bodies are piped directly and never buffered or parsed here.
 */
function createRoutingHandler({ bridges, registry }) {
  return (req, res) => {
    let url;
    try {
      url = new URL(req.url, "http://internal");
    } catch {
      const rawPath = typeof req.url === "string" ? req.url.split("?", 1)[0] : "";
      if (isMcpNamespace(rawPath)) res.writeHead(400).end();
      return isMcpNamespace(rawPath);
    }

    if (!isMcpNamespace(url.pathname)) return false;

    const adapterId = matchAdapterPath(url.pathname);
    if (!adapterId) {
      res.writeHead(404).end();
      return true;
    }

    let entry;
    try {
      entry = registry.get(adapterId);
    } catch (error) {
      if (error instanceof UnknownAdapterError) {
        res.writeHead(404).end("unknown adapter");
        return true;
      }
      res.writeHead(500).end();
      return true;
    }
    if (entry.state !== AdapterState.RUNNING) {
      res.writeHead(409).end(`adapter "${adapterId}" is not running`);
      return true;
    }

    const bridge = bridges.get(adapterId);
    if (!bridge) {
      res.writeHead(503).end(`adapter "${adapterId}" has no active gateway bridge`);
      return true;
    }

    const outgoingHeaders = { ...req.headers };
    delete outgoingHeaders.host;
    const proxyRequest = http.request(
      {
        headers: outgoingHeaders,
        host: bridge.host,
        method: req.method,
        path: `/mcp${url.search}`,
        port: bridge.port
      },
      (proxyResponse) => {
        res.writeHead(proxyResponse.statusCode ?? 502, proxyResponse.headers);
        proxyResponse.pipe(res);
      }
    );
    proxyRequest.on("error", (error) => {
      console.error("[majiwari-gateway] error proxying a request to an adapter's internal bridge", error);
      if (res.headersSent) res.destroy();
      else res.writeHead(502).end();
    });
    req.pipe(proxyRequest);
    return true;
  };
}

function mountRequestHandler(server, handler) {
  if (!server || typeof server.on !== "function") {
    throw new TypeError("gateway mount requires an externally owned Node HTTP server");
  }
  server.on("request", handler);
  return () => server.off("request", handler);
}

function listen(server, port, host) {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, () => {
      server.off("error", reject);
      resolve(server);
    });
  });
}

export class GatewayAttachError extends Error {
  constructor(message, options) {
    super(message, options);
    this.name = "GatewayAttachError";
  }
}

/**
 * Create the generic multi-adapter gateway.
 *
 * With `port`, this retains the standalone gateway server used by existing
 * CLIs/tests. With `server`, it mounts request handling on an externally
 * owned ingress and never closes that server. With neither, callers can use
 * the returned `handle`/`mount` API to compose their own ingress.
 */
export async function createRegistryGateway({ registry, host = "127.0.0.1", port, server } = {}) {
  if (!registry) throw new TypeError("createRegistryGateway requires an AdapterRegistry");
  if (server && port !== undefined) {
    throw new TypeError("gateway cannot own a port when an external HTTP server is supplied");
  }

  const bridges = new Map();
  // Only the old publish()/unpublish() compatibility wrapper owns these
  // lifecycle entries. Explicit attach()/detach() never adds to this set.
  const compatibilityPublished = new Set();
  const routingHandler = createRoutingHandler({ bridges, registry });
  let ownedServer;
  let unmountExternal;
  let closed = false;

  if (server) {
    unmountExternal = mountRequestHandler(server, routingHandler);
  } else if (port !== undefined) {
    ownedServer = http.createServer((req, res) => {
      if (!routingHandler(req, res)) res.writeHead(404).end();
    });
    await listen(ownedServer, port, host);
  }

  /** Attach an already-running registry adapter without changing lifecycle. */
  async function attach(adapterId) {
    const entry = registry.get(adapterId);
    if (entry.state !== AdapterState.RUNNING) {
      throw new GatewayAttachError(
        `cannot attach adapter "${adapterId}": adapter is not running (state: ${entry.state})`
      );
    }
    if (bridges.has(adapterId)) return entry;

    let bridge;
    try {
      bridge = await startAdapterBridge({ registry, adapterId });
    } catch (error) {
      throw new GatewayAttachError(`cannot attach adapter "${adapterId}": ${error.message}`, { cause: error });
    }
    bridges.set(adapterId, bridge);
    return registry.get(adapterId);
  }

  /** Detach downstream sessions/bridge while leaving the registry resource running. */
  async function detach(adapterId) {
    const entry = registry.get(adapterId);
    const bridge = bridges.get(adapterId);
    bridges.delete(adapterId);
    if (bridge) await bridge.close();
    return entry;
  }

  /**
   * Roll back only state acquired by the compatibility publish() wrapper.
   * attach()/detach() never call this helper: a resident runtime's registry
   * entry must remain observable after a direct lifecycle failure.
   */
  async function cleanupCompatibilityEntry(id) {
    try {
      await registry.stop(id);
    } catch (error) {
      console.error("[majiwari-gateway] failed to stop a compatibility-published adapter during rollback", error);
      return false;
    }
    try {
      registry.unregister(id);
      return true;
    } catch (error) {
      console.error("[majiwari-gateway] failed to unregister a compatibility-published adapter during rollback", error);
      return false;
    }
  }

  /**
   * Compatibility wrapper for the historical standalone/test API. It owns
   * only the lifecycle of the manifest it registers, then delegates the
   * publication step to attach(). A failed compatibility publish rolls back
   * its own registry entry so the historical same-id retry contract remains.
   */
  async function publish(manifest) {
    const registered = registry.register(manifest);
    const id = registered.id;
    compatibilityPublished.add(id);

    let started;
    try {
      started = await registry.start(id);
    } catch (error) {
      if (await cleanupCompatibilityEntry(id)) compatibilityPublished.delete(id);
      throw error;
    }
    if (started.state !== AdapterState.RUNNING) {
      if (await cleanupCompatibilityEntry(id)) compatibilityPublished.delete(id);
      throw new Error(`adapter "${id}" failed to start: ${started.error ?? "unknown error"}`);
    }

    try {
      await attach(id);
    } catch (error) {
      // This compatibility path started the resource itself, so it also
      // releases and unregisters it. attach()/detach() remain lifecycle-neutral.
      if (await cleanupCompatibilityEntry(id)) compatibilityPublished.delete(id);
      throw error;
    }
    return registry.get(id);
  }

  /** Compatibility wrapper for publish(); new runtime code should use detach(). */
  async function unpublish(id) {
    let detachError;
    try {
      await detach(id);
    } catch (error) {
      detachError = error;
    }
    compatibilityPublished.delete(id);
    const stopped = await registry.stop(id);
    if (detachError) throw detachError;
    return stopped;
  }

  function mount(externalServer) {
    if (ownedServer) throw new Error("gateway already owns its HTTP server");
    if (unmountExternal) throw new Error("gateway is already mounted on an HTTP server");
    unmountExternal = mountRequestHandler(externalServer, routingHandler);
    return unmountExternal;
  }

  function handle(req, res) {
    return routingHandler(req, res);
  }

  async function close() {
    if (closed) return;
    closed = true;
    unmountExternal?.();
    unmountExternal = undefined;

    await Promise.allSettled([...bridges.keys()].map((id) => detach(id)));
    await Promise.allSettled(
      [...compatibilityPublished].map(async (id) => {
        try {
          await registry.stop(id);
        } catch (error) {
          console.error("[majiwari-gateway] failed to stop a compatibility-published adapter during close", error);
        }
      })
    );
    compatibilityPublished.clear();

    if (ownedServer) {
      await new Promise((resolve, reject) => {
        ownedServer.close((error) => (error ? reject(error) : resolve()));
      });
    }
  }

  return {
    attach,
    close,
    detach,
    handle,
    handler: handle,
    host,
    mount,
    port: ownedServer?.address()?.port ?? server?.address?.()?.port,
    publish,
    unmount: () => {
      unmountExternal?.();
      unmountExternal = undefined;
    },
    unpublish
  };
}
