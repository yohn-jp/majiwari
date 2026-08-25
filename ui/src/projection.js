/**
 * Pure registry-to-JSON projections for the operator UI shell. These are
 * the only functions that decide what the shell shows -- they read only
 * the registry's own generic surface (list/get/tools/health/listTargets)
 * and never branch on a specific adapter id, so adding a fixture adapter
 * changes what these return without changing this file.
 */
import { TargetCapabilityUnsupportedError } from "@majiwari/registry";

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}

/**
 * registry.tools() delegates directly to an adapter's own listTools()
 * with no internal try/catch (registry/src/registry.js), so a rejecting
 * listTools() would otherwise fail the whole detail projection. Bound it
 * to its own section instead: a broken tool-discovery capability never
 * hides identity, health, or another adapter's detail view.
 */
async function projectTools(registry, id) {
  try {
    return { ok: true, items: await registry.tools(id) };
  } catch (error) {
    return { ok: false, items: [], error: errorMessage(error) };
  }
}

/**
 * registry.health() already catches a rejecting health() itself and
 * folds it into a normalized `{ ok: false, error }` shape rather than
 * throwing (registry/src/registry.js), but this is guarded the same way
 * as the other optional sections so a future registry change here still
 * cannot take down the rest of the detail projection.
 */
async function projectHealth(registry, id) {
  try {
    return await registry.health(id);
  } catch (error) {
    return { ok: false, error: errorMessage(error) };
  }
}

/**
 * Generic, adapter-agnostic projection of the optional target-provider
 * capability (#26). An adapter that never declares `manifest.
 * targetProvider` makes registry.listTargets() throw
 * TargetCapabilityUnsupportedError -- that is not a failure, it is the
 * generic "this adapter does not have this optional capability" signal,
 * projected as `{ supported: false }` rather than an error. Any other
 * rejection (the declared provider's own list() throwing) is a real,
 * isolated failure for this section alone.
 *
 * Only registry.listTargets() is ever called here -- never getTarget()/
 * resolveTarget() -- so this projection can only ever surface the public
 * target schema (registry/src/target-provider.js's publicTargetSchema),
 * which has no field for an adapter-internal resolved descriptor.
 */
async function projectTargets(registry, id) {
  try {
    const items = await registry.listTargets(id);
    return { supported: true, ok: true, items };
  } catch (error) {
    if (error instanceof TargetCapabilityUnsupportedError) {
      return { supported: false, ok: true, items: [] };
    }
    return { supported: true, ok: false, items: [], error: errorMessage(error) };
  }
}

export function projectAdapterList(registry) {
  return registry.list();
}

export async function projectAdapterDetail(registry, id) {
  // registry.get() throws UnknownAdapterError synchronously for an unknown
  // id; let it propagate so the caller (the HTTP layer) maps it to 404
  // instead of this module deciding transport-level behavior.
  const summary = registry.get(id);
  const [tools, health, targets] = await Promise.all([projectTools(registry, id), projectHealth(registry, id), projectTargets(registry, id)]);
  return { ...summary, tools, health, targets };
}
