/**
 * Pure registry-to-JSON projections for the operator UI shell. These are
 * the only functions that decide what the shell shows -- they read only
 * the registry's own generic surface (list/get/tools/health) and never
 * branch on a specific adapter id, so adding a fixture adapter changes
 * what these return without changing this file.
 */

export function projectAdapterList(registry) {
  return registry.list();
}

export async function projectAdapterDetail(registry, id) {
  // registry.get() throws UnknownAdapterError synchronously for an unknown
  // id; let it propagate so the caller (the HTTP layer) maps it to 404
  // instead of this module deciding transport-level behavior.
  const summary = registry.get(id);
  const [tools, health] = await Promise.all([registry.tools(id), registry.health(id)]);
  return { ...summary, tools, health };
}
