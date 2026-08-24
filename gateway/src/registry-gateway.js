import { Server } from "@modelcontextprotocol/server";
import { AdapterState, UnknownAdapterError } from "@majiwari/registry";
import { proxyServer, startHTTPServer } from "mcp-proxy";

/**
 * Header carrying the registered adapter identity for a session's
 * initializing request. Read once, when a new session is created --
 * every later request on that session is already keyed by its own
 * `Mcp-Session-Id` and never needs to repeat it.
 */
export const ADAPTER_ID_HEADER = "mcp-adapter-id";

function readAdapterId(req) {
  const value = req.headers[ADAPTER_ID_HEADER];
  return Array.isArray(value) ? value[0] : value;
}

/**
 * Publish every RUNNING adapter in `registry` on one Streamable HTTP
 * gateway. No adapter-specific or adapter-type-specific branching: routing
 * is a single deterministic lookup of the registered adapter id carried on
 * the `Mcp-Adapter-Id` header. Each adapter keeps exactly one upstream
 * client/process, acquired through the registry's own start()/stop(); a
 * downstream session only ever gets a fresh per-session `Server` bridged
 * onto that adapter's client, so tool discovery/invocation always reaches
 * the selected adapter's own native names, schemas, and results.
 */
export async function createRegistryGateway({ registry, host = "127.0.0.1", port, streamEndpoint = "/mcp", sseEndpoint = null }) {
  // Every adapter id this gateway has published, whether or not a session
  // was ever opened against it -- close() needs this to release every
  // adapter's resource, not just the ones a client happened to use.
  const publishedIds = new Set();

  // Adapter id -> the set of currently open per-session Server instances
  // routed to it, so a restart/removal can close exactly the sessions it
  // owns and never touch another adapter's sessions or process.
  const sessionsByAdapter = new Map();

  function trackSession(adapterId, session) {
    let sessions = sessionsByAdapter.get(adapterId);
    if (!sessions) {
      sessions = new Set();
      sessionsByAdapter.set(adapterId, sessions);
    }
    sessions.add(session);
  }

  function untrackSession(adapterId, session) {
    sessionsByAdapter.get(adapterId)?.delete(session);
  }

  const httpServer = await startHTTPServer({
    createServer: async (req) => {
      const adapterId = readAdapterId(req);
      if (!adapterId) throw new Response(null, { status: 400, statusText: `missing ${ADAPTER_ID_HEADER} header` });

      let entry;
      try {
        entry = registry.get(adapterId);
      } catch (error) {
        if (error instanceof UnknownAdapterError) throw new Response(null, { status: 404, statusText: "unknown adapter" });
        throw error;
      }
      if (entry.state !== AdapterState.RUNNING) {
        throw new Response(null, { status: 409, statusText: `adapter "${adapterId}" is not running` });
      }

      const resource = registry.resource(adapterId);
      if (!resource?.client) throw new Response(null, { status: 500, statusText: `adapter "${adapterId}" has no gateway-routable resource` });

      const session = new Server(resource.serverVersion, { capabilities: resource.serverCapabilities });
      await proxyServer({ client: resource.client, server: session, serverCapabilities: resource.serverCapabilities });

      trackSession(adapterId, session);
      const previousOnClose = session.onclose;
      session.onclose = () => {
        untrackSession(adapterId, session);
        previousOnClose?.();
      };

      return session;
    },
    host,
    port,
    sseEndpoint,
    streamEndpoint
  });

  /**
   * Register and start an adapter so the gateway begins accepting new
   * sessions for it. Throws if the manifest is invalid, the id is already
   * registered, or the adapter's own transport fails to start.
   */
  async function publish(manifest) {
    const registered = registry.register(manifest);
    const started = await registry.start(registered.id);
    if (started.state !== AdapterState.RUNNING) {
      throw new Error(`adapter "${registered.id}" failed to start: ${started.error ?? "unknown error"}`);
    }
    publishedIds.add(registered.id);
    return started;
  }

  /**
   * Stop routing new sessions to `id`, close every session currently routed
   * to it, and release its one upstream resource -- all without touching
   * any other adapter's sessions or resource. Also releases an adapter that
   * was published but never given an active session.
   */
  async function unpublish(id) {
    publishedIds.delete(id);
    const sessions = sessionsByAdapter.get(id);
    sessionsByAdapter.delete(id);
    if (sessions) {
      await Promise.allSettled([...sessions].map((session) => session.close()));
    }
    return registry.stop(id);
  }

  async function close() {
    await Promise.allSettled([...publishedIds].map((id) => unpublish(id)));
    await httpServer.close();
  }

  return { close, host, port, publish, unpublish };
}
