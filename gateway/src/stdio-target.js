import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";

/**
 * Build a registry manifest's `transport` for an adapter reached by spawning
 * a stdio MCP server. Conforms to the registry's opaque "stdio" contract
 * (`start()` acquires, `stop(handle)` releases) -- see `registry/src/manifest.js`.
 *
 * The handle returned by `start()` satisfies the gateway-routable transport
 * contract (`gateway/src/gateway-transport.js`): a connected MCP `mcpClient`
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
      try {
        await client.connect(transport, connectionTimeout ? { timeout: connectionTimeout } : undefined);
      } catch (error) {
        // connect() can have already spawned the child process and/or
        // partially negotiated before failing (a timeout, a rejected
        // handshake) -- release whatever it acquired so a retried start()
        // for this same adapter id never inherits a leaked process.
        await client.close().catch(() => {});
        throw error;
      }
      return {
        mcpClient: client,
        serverVersion: client.getServerVersion(),
        serverCapabilities: client.getServerCapabilities()
      };
    },
    stop: async (handle) => {
      await handle?.mcpClient?.close();
    }
  };
}
