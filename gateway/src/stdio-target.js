import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";

/**
 * Build a registry manifest's `transport` for an adapter reached by spawning
 * a stdio MCP server. Conforms to the registry's opaque "stdio" contract
 * (`start()` acquires, `stop(handle)` releases) -- see `registry/src/manifest.js`.
 *
 * The handle returned by `start()` is this module's own convention for what
 * a gateway-routable "stdio" resource contains: a connected MCP `client`
 * plus the `serverVersion`/`serverCapabilities` it negotiated, so
 * `gateway/src/registry-gateway.js` can bridge downstream sessions onto it
 * without re-negotiating per session. The registry itself never looks
 * inside this handle.
 */
export function createStdioGatewayTransport({ command, args = [], env, connectionTimeout }) {
  return {
    kind: "stdio",
    start: async () => {
      const client = new Client({ name: "majiwari-gateway", version: "1.0.0" }, { capabilities: {} });
      const transport = new StdioClientTransport({ command, args, env, stderr: "inherit" });
      await client.connect(transport, connectionTimeout ? { timeout: connectionTimeout } : undefined);
      return {
        client,
        serverVersion: client.getServerVersion(),
        serverCapabilities: client.getServerCapabilities()
      };
    },
    stop: async (handle) => {
      await handle?.client?.close();
    }
  };
}
