import { Client } from "@modelcontextprotocol/client";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { parseTargetId, TargetNotFoundError, TargetUnavailableError, validateResolvedTarget } from "@majiwari/registry";
import { extractDescriptorRepoRoot, resolveRepoRoot } from "./core.js";
import { createOcrServer } from "./build-server.js";

/**
 * Build the per-call execution-context resolver for managed mode: the
 * *only* place OCR ever calls into the configured target-provider
 * authority. Every workspace-sensitive tool call resolves through here,
 * immediately before its own OCR/git/filesystem access, and nothing here
 * is cached across calls -- there is no process-global/current/selected
 * target, only this one function closing over the injected provider.
 */
function createManagedResolveContext(targetProvider) {
  return async (targetId) => {
    if (typeof targetId !== "string" || targetId.length === 0) {
      throw new Error("targetId is required for every workspace-sensitive tool call in managed mode");
    }
    // Opaque-id validation before the id ever reaches the provider's own
    // resolve() -- a path-shaped/traversal id is rejected here, same
    // boundary @majiwari/registry's own AdapterRegistry#resolveTarget uses.
    const safeId = parseTargetId(targetId);

    let resolved;
    try {
      resolved = await targetProvider.resolve(safeId);
    } catch (error) {
      // Only these two exact, registry-defined error shapes are trusted to
      // reach an MCP response unchanged -- both are hard-coded to embed
      // nothing but the caller's own opaque targetId
      // (`no target registered with id "<id>"` / `target "<id>" is
      // unavailable`), never adapter-internal detail. Any other error --
      // including a *subclass* of the base TargetProviderError, which a
      // provider implementation is free to throw with an arbitrary message
      // (e.g. one that embeds a resolved worktree path) -- is normalized
      // instead of forwarded, so a custom/unexpected provider failure can
      // never leak internal detail through this boundary.
      if (error instanceof TargetNotFoundError || error instanceof TargetUnavailableError) throw error;
      throw new Error(`failed to resolve target "${safeId}"`);
    }

    // Malformed resolved descriptors fail closed: both the registry's own
    // shape contract (validateResolvedTarget) and OCR's own descriptor
    // convention (extractDescriptorRepoRoot: an absolute repoRoot) must
    // hold before any git/OCR/filesystem access happens.
    const validated = validateResolvedTarget(resolved);
    const rawRepoRoot = extractDescriptorRepoRoot(validated.descriptor);

    try {
      // Re-derive and canonicalize through the same git-toplevel resolution
      // standalone mode uses, fresh on every call -- never cached as a
      // "current" target across calls.
      return await resolveRepoRoot(rawRepoRoot);
    } catch {
      throw new Error(`target "${safeId}" does not resolve to a usable repository`);
    }
  };
}

/**
 * The adapter-local managed transport (#29): one resident MCP server
 * bridged in-process to its own connected mcpClient, satisfying the same
 * gateway-routable contract (`gateway/src/gateway-transport.js`) the
 * standalone stdio child does, without spawning a second process and
 * without ever putting a resolved repository path on any wire protocol --
 * client and server share one Node process and one function-call boundary.
 *
 * Reports `kind: "stdio"` because that is the registry's generic
 * "call transport.start()/stop()" lifecycle contract this satisfies
 * (`registry/src/registry.js`); it is not an actual child process.
 */
export function createManagedTransport({ targetProvider }) {
  const resolveExecutionContext = createManagedResolveContext(targetProvider);

  return {
    kind: "stdio",
    start: async () => {
      const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
      const server = createOcrServer({ resolveExecutionContext, healthCwd: process.cwd() });
      await server.connect(serverTransport);

      const client = new Client({ name: "majiwari-gateway", version: "1.0.0" }, { capabilities: {} });
      await client.connect(clientTransport);

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
