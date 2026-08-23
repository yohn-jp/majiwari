/** True only for the two paths this Worker serves outside the OAuth-protected /mcp route. */
export function isPublicRoute(pathname: string): "health" | "authorize" | "not-found" {
  if (pathname === "/health") return "health";
  if (pathname === "/authorize") return "authorize";
  return "not-found";
}
