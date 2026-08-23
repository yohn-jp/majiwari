/** Classifies each path this Worker serves: the health check, the Access-protected MCP endpoint, or nothing. */
export function classifyRoute(pathname: string): "health" | "mcp" | "not-found" {
  if (pathname === "/health") return "health";
  if (pathname === "/mcp") return "mcp";
  return "not-found";
}
