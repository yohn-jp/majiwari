import path from "node:path";
import { fileURLToPath } from "node:url";
import { createStdioGatewayTransport } from "@majiwari/gateway";
import { checkAdapterHealth, resolveRepoRoot } from "./core.js";
import { createManagedTransport } from "./managed-transport.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SERVER_ENTRY = path.join(__dirname, "server.js");

export const ADAPTER_ID = "open-code-review";
export const ADAPTER_VERSION = "0.1.0";

const COMMON_MANIFEST_FIELDS = {
  schemaVersion: "1",
  id: ADAPTER_ID,
  version: ADAPTER_VERSION,
  displayName: "OpenCodeReview",
  capabilities: ["code-review", "read-only"]
};

/**
 * Build the @majiwari/registry manifest for the OCR adapter.
 *
 * Without `targetProvider`, this is unchanged standalone/single-repository
 * behavior: registering the manifest starts the same unchanged stdio MCP
 * server (`src/server.js`) as a child process bound to one repository for
 * its whole lifetime -- a second way to host it, not a replacement. `npm
 * start` keeps running `src/server.js` standalone, independent of the
 * registry.
 *
 * With `targetProvider` (#29), the manifest is target-aware and managed:
 * one resident MCP server (in-process, `managed-transport.js`) resolves a
 * fresh repository root per workspace-sensitive call from the injected
 * target-provider authority, so it can safely serve multiple managed
 * targets without restarting. `targetProvider` is passed straight through
 * onto the manifest so `@majiwari/registry`'s own `listTargets`/`getTarget`/
 * `resolveTarget`/`invalidateTarget` use the exact same authority OCR's own
 * tool execution does -- no second, independently mutable target catalog.
 *
 * Either way, the transport resolves the explicit gateway-routable handle
 * shape (`gateway/src/gateway-transport.js`: a connected `mcpClient` plus
 * the `serverVersion`/`serverCapabilities` it negotiated), so this adapter
 * can be published through `createRegistryGateway` at `/mcp/open-code-review`
 * with no OCR-specific code in `gateway/` or `registry/`.
 */
export function createManifest({ repo, stderr = "inherit", targetProvider } = {}) {
  return targetProvider ? createManagedManifest({ targetProvider }) : createStandaloneManifest({ repo, stderr });
}

function createStandaloneManifest({ repo, stderr }) {
  const transport = createStdioGatewayTransport({
    command: process.execPath,
    args: repo ? [SERVER_ENTRY, "--repo", repo] : [SERVER_ENTRY],
    stderr
  });
  let resource;

  return {
    ...COMMON_MANIFEST_FIELDS,
    transport: {
      kind: "stdio",
      start: async () => {
        resource = await transport.start();
        return resource;
      },
      stop: async (handle) => {
        await transport.stop(handle);
        resource = undefined;
      }
    },
    // Re-derives repo/git/OCR support deterministically on every call rather
    // than asking the running child (cheap `git rev-parse`/`ocr --version`
    // checks, not an OCR CLI review call) -- and strips `repo_root` (an
    // absolute host filesystem path) before returning, since this detail feeds
    // the generic registry health/status contract, which is public surface.
    // The `adapter_health` MCP tool strips the same field; only the local
    // doctor report keeps it.
    health: async () => {
      const repoRoot = await resolveRepoRoot(repo);
      const { repo_root: _repoRoot, ...publicHealth } = await checkAdapterHealth(repoRoot);
      return publicHealth;
    },
    // Generic tool discovery for the registry/gateway contract: while the
    // adapter is running, ask its own connected mcpClient (the same one
    // gateway routing uses) for its live tool list via the MCP protocol,
    // rather than maintaining a second, hand-kept copy of server.js's tool
    // names/schemas here.
    listTools: async () => {
      if (!resource) return [];
      const { tools } = await resource.mcpClient.listTools();
      return tools;
    }
  };
}

function createManagedManifest({ targetProvider }) {
  const transport = createManagedTransport({ targetProvider });
  let resource;

  return {
    ...COMMON_MANIFEST_FIELDS,
    transport: {
      kind: "stdio",
      start: async () => {
        resource = await transport.start();
        return resource;
      },
      stop: async (handle) => {
        await transport.stop(handle);
        resource = undefined;
      }
    },
    // adapter/process health only (#29): no repository is bound to the
    // process itself in managed mode, so this checks git/OCR CLI support
    // from the process's own cwd rather than any managed target. Target
    // availability is represented by the target-provider APIs, not here.
    health: async () => {
      const { repo_root: _repoRoot, ...publicHealth } = await checkAdapterHealth(process.cwd());
      return publicHealth;
    },
    listTools: async () => {
      if (!resource) return [];
      const { tools } = await resource.mcpClient.listTools();
      return tools;
    },
    // Same object the managed transport resolves tool calls through --
    // the single target-provider authority for this adapter, exposed
    // generically per #26 (registry.listTargets/getTarget/resolveTarget/
    // invalidateTarget) with no duplicated target catalog.
    targetProvider
  };
}
