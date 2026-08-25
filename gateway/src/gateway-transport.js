/**
 * The gateway-routable transport contract.
 *
 * `registry/` stays opaque to what an adapter's `transport.start()`/
 * `connect()` returns -- it only tracks whether a handle was acquired
 * (`registry/src/registry.js#resource`). The gateway is the one layer that
 * actually has to reach inside that handle to bridge a downstream session
 * onto it, so the contract for what a *gateway-routable* handle must expose
 * is defined and validated here, not left as an implicit shape a transport
 * happens to produce.
 *
 * Any transport kind -- "stdio" (`gateway/src/stdio-target.js`) or a future
 * "endpoint" transport reaching a remote MCP server -- satisfies this by
 * resolving `start()`/`connect()` with an object shaped:
 *
 * ```
 * {
 *   mcpClient: Client,              // connected @modelcontextprotocol/client
 *                                   // instance, reused across every
 *                                   // downstream session this gateway opens
 *                                   // for the adapter
 *   serverVersion: Implementation,  // as returned by mcpClient.getServerVersion()
 *   serverCapabilities: ServerCapabilities // as returned by
 *                                   // mcpClient.getServerCapabilities()
 * }
 * ```
 *
 * This is a plain object shape, not a class, so a manifest author never has
 * to import anything from `@majiwari/gateway` to satisfy it -- only
 * `@modelcontextprotocol/client`, which any MCP-speaking transport already
 * depends on.
 */

/**
 * Validate that `resource` (from `registry.resource(adapterId)`) satisfies
 * the gateway-routable contract above, and return it typed as such. Throws a
 * clear, adapter-identified error naming the missing/malformed field instead
 * of failing later with an implicit `undefined is not a function` deep
 * inside `proxyServer`.
 */
export function toGatewayRoutableResource(resource, adapterId) {
  if (!resource || typeof resource !== "object") {
    throw new Error(`adapter "${adapterId}" has no gateway-routable resource (registry.resource() returned nothing)`);
  }
  if (typeof resource.mcpClient?.request !== "function") {
    throw new Error(`adapter "${adapterId}" resource does not satisfy the gateway-routable transport contract: missing a connected "mcpClient"`);
  }
  if (!resource.serverVersion) {
    throw new Error(`adapter "${adapterId}" resource does not satisfy the gateway-routable transport contract: missing "serverVersion"`);
  }
  if (!resource.serverCapabilities) {
    throw new Error(`adapter "${adapterId}" resource does not satisfy the gateway-routable transport contract: missing "serverCapabilities"`);
  }
  return resource;
}
