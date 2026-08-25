import { Server } from "@modelcontextprotocol/server";
import { AdapterState, ID_PATTERN, UnknownAdapterError } from "@majiwari/registry";
import { proxyServer, startHTTPServer } from "mcp-proxy";
import http from "node:http";
import net from "node:net";
import { toGatewayRoutableResource } from "./gateway-transport.js";

/**
 * Public path an adapter's MCP endpoint is reached at:
 * `/mcp/<adapterId>`. Majiwari is the single ingress -- Cloudflare/public
 * infrastructure (`deployments/cloudflare/`) routes everything to this one
 * gateway, never to an adapter directly, and this is the one deterministic
 * lookup that decides which registered adapter a request reaches. Never a
 * branch on adapter type, transport kind, or capabilities.
 *
 * Built from the manifest contract's own `ID_PATTERN` (`registry/src/
 * manifest.js`) rather than a generic `[^/]+` capture, so the id segment is
 * matched against the exact syntax a registrable adapter id can ever have:
 * lowercase-alphanumeric-and-hyphen only. That makes URL-decoding the
 * segment unnecessary -- no valid id ever needs percent-encoding -- so this
 * router never calls `decodeURIComponent()` on request-controlled input.
 * Malformed percent-encoding, a path-shaped id (`../etc`), or anything
 * outside the manifest's own charset all simply fail to match and are
 * rejected deterministically (404) rather than reaching `decodeURIComponent`
 * and throwing a `URIError` out of the request handler.
 */
const ADAPTER_PATH = new RegExp(`^/mcp/(${ID_PATTERN.source.slice(1, -1)})$`);

/**
 * Loopback-only host each adapter's own internal MCP bridge binds to.
 * `mcp-proxy`'s `startHTTPServer` serves exactly one fixed `streamEndpoint`
 * pathname per instance, so it cannot itself multiplex `/mcp/:adapterId` --
 * this gateway therefore gives each published adapter its own internal
 * `startHTTPServer` instance on a loopback-only port, and the public
 * `ADAPTER_PATH` router in front of them is a plain byte-for-byte HTTP
 * reverse proxy that never touches MCP semantics (message framing, sessions,
 * tool schemas/results all stay entirely `mcp-proxy`'s job, unmodified).
 * Adapter-local endpoint/transport discovery is an internal implementation
 * detail: nothing outside this module ever sees these ports.
 */
const INTERNAL_BRIDGE_HOST = "127.0.0.1";

function matchAdapterPath(pathname) {
  const match = ADAPTER_PATH.exec(pathname);
  return match ? match[1] : undefined;
}

/**
 * `AdapterRegistry#unregister` is synchronous and throws (it never resolves
 * a rejected promise), so a best-effort "clear this dead entry" call needs a
 * real try/catch, not a `.catch()` chained onto its (non-existent) promise.
 */
function unregisterQuietly(registry, id) {
  try {
    registry.unregister(id);
  } catch (error) {
    console.error(`[majiwari-gateway] failed to clear adapter "${id}"'s entry for retry`, error);
  }
}

function getFreePort(host) {
  return new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.on("error", reject);
    probe.listen(0, host, () => {
      const { port } = probe.address();
      probe.close(() => resolve(port));
    });
  });
}

/**
 * Start one adapter's own internal MCP bridge: a loopback-only `mcp-proxy`
 * Streamable HTTP server dedicated to this adapter alone, bridging every
 * downstream session onto its one shared upstream `mcpClient` via
 * `proxyServer`. Nothing about this instance is adapter-type-specific --
 * it only depends on the resource satisfying the gateway-routable contract.
 */
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
 * The public `/mcp/:adapterId` router: a byte-for-byte HTTP reverse proxy
 * (method, headers, streaming request/response body) onto the selected
 * adapter's own internal bridge. Rejects an unknown, unpublished, or
 * not-yet-running adapter id before any session is ever created downstream.
 */
function createRoutingServer({ bridges, host, port, registry }) {
  const httpServer = http.createServer((req, res) => {
    let url;
    try {
      url = new URL(req.url, "http://internal");
    } catch {
      res.writeHead(400).end();
      return;
    }

    const adapterId = matchAdapterPath(url.pathname);
    if (!adapterId) {
      res.writeHead(404).end();
      return;
    }

    let entry;
    try {
      entry = registry.get(adapterId);
    } catch (error) {
      if (error instanceof UnknownAdapterError) {
        res.writeHead(404).end("unknown adapter");
        return;
      }
      res.writeHead(500).end();
      return;
    }
    if (entry.state !== AdapterState.RUNNING) {
      res.writeHead(409).end(`adapter "${adapterId}" is not running`);
      return;
    }

    const bridge = bridges.get(adapterId);
    if (!bridge) {
      res.writeHead(503).end(`adapter "${adapterId}" has no active gateway bridge`);
      return;
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
      // No request-derived value (not adapterId, not even bridge, which was
      // looked up by it) is interpolated into this log line -- only a fixed
      // string and the Error object itself, so nothing about this write can
      // trace back to the request that triggered it.
      console.error("[majiwari-gateway] error proxying a request to an adapter's internal bridge", error);
      if (res.headersSent) res.destroy();
      else res.writeHead(502).end();
    });
    req.pipe(proxyRequest);
  });

  return new Promise((resolve, reject) => {
    httpServer.once("error", reject);
    httpServer.listen(port, host, () => resolve(httpServer));
  });
}

/**
 * Publish every RUNNING adapter in `registry` on one deterministic,
 * path-routed Streamable HTTP gateway (`/mcp/:adapterId`). No adapter-
 * specific or adapter-type-specific branching. Each adapter keeps exactly
 * one upstream `mcpClient`/process, acquired through the registry's own
 * start()/stop(); a downstream session only ever gets a fresh per-session
 * `Server` bridged onto that adapter's own internal bridge, so tool
 * discovery/invocation always reaches the selected adapter's own native
 * names, schemas, and results.
 */
export async function createRegistryGateway({ registry, host = "127.0.0.1", port }) {
  // Adapter id -> its own internal bridge (host/port/close). Existing only
  // for adapters this gateway has successfully published; removed the
  // instant unpublish()/a failed publish() releases it, so the routing
  // server above rejects a request the moment there is nothing to route to.
  const bridges = new Map();

  const routingServer = await createRoutingServer({ bridges, host, port, registry });
  const boundPort = routingServer.address().port;

  /**
   * Register and start an adapter, then bring up its own internal gateway
   * bridge. A failure at any step releases whatever the earlier steps
   * acquired and clears the adapter's registry entry, so the same adapter
   * id can always be safely retried by a later publish() call -- a failed
   * publish() never leaves state that blocks or corrupts a retry.
   */
  async function publish(manifest) {
    const registered = registry.register(manifest);
    const id = registered.id;

    let started;
    try {
      started = await registry.start(id);
    } catch (error) {
      // start() only throws for a registry usage bug (unknown id), which
      // cannot happen right after register() -- guard anyway, and leave no
      // half-registered entry behind either way.
      unregisterQuietly(registry, id);
      throw error;
    }
    if (started.state !== AdapterState.RUNNING) {
      // registry.start() already isolated the transport failure onto this
      // entry (ERRORED, nothing acquired) without throwing. Clear the entry
      // so a retry of this id can register() again instead of colliding
      // with a DuplicateAdapterError.
      unregisterQuietly(registry, id);
      throw new Error(`adapter "${id}" failed to start: ${started.error ?? "unknown error"}`);
    }

    let bridge;
    try {
      bridge = await startAdapterBridge({ registry, adapterId: id });
    } catch (error) {
      // The upstream resource (client/process) is acquired at this point --
      // only the internal bridge failed to come up. Release the upstream
      // resource and clear the entry so the id is retryable, rather than
      // leaving a RUNNING/ERRORED adapter with no route to it.
      await registry.stop(id).catch((stopError) => {
        console.error(`[majiwari-gateway] failed to release adapter "${id}" after its bridge failed to start`, stopError);
      });
      unregisterQuietly(registry, id);
      throw new Error(`adapter "${id}" failed to start its gateway bridge: ${error.message}`, { cause: error });
    }

    bridges.set(id, bridge);
    return registry.get(id);
  }

  /**
   * Stop routing new requests to `id`, close every session currently routed
   * to it (via its own internal bridge's close()), and release its one
   * upstream resource -- all without touching any other adapter's sessions,
   * bridge, or resource. Also releases an adapter that was published but
   * never given an active session.
   */
  async function unpublish(id) {
    const bridge = bridges.get(id);
    bridges.delete(id);
    if (bridge) {
      await bridge.close();
    }
    return registry.stop(id);
  }

  async function close() {
    await Promise.allSettled([...bridges.keys()].map((id) => unpublish(id)));
    await new Promise((resolve, reject) => {
      routingServer.close((error) => (error ? reject(error) : resolve()));
    });
  }

  return { close, host, port: boundPort, publish, unpublish };
}
