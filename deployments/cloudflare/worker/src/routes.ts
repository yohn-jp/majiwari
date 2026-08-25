/**
 * Matches the gateway's own path-based MCP endpoint contract
 * (`/mcp/:adapterId`, see `gateway/src/registry-gateway.js`), plus the bare
 * `/mcp` the gateway's single-target CLI (`gateway/bin/gateway.mjs`) still
 * serves for the existing single-adapter deployment.
 */
const MCP_PATH = /^\/mcp(\/[^/]+)?$/;

/** Classifies each path this Worker serves: the health check, the Access-protected MCP endpoint, or nothing. */
export function classifyRoute(pathname: string): "health" | "mcp" | "not-found" {
  if (pathname === "/health") return "health";
  if (MCP_PATH.test(pathname)) return "mcp";
  return "not-found";
}
