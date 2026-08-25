import path from "node:path";
import { fileURLToPath } from "node:url";
import { createStdioGatewayTransport } from "@majiwari/gateway";
import { checkAdapterHealth, resolveRepoRoot } from "./core.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SERVER_ENTRY = path.join(__dirname, "server.js");

export const ADAPTER_ID = "inari";
export const ADAPTER_VERSION = "0.1.0";

/**
 * Build the @majiwari/registry manifest for the Inari adapter. Registering
 * this manifest starts the same unchanged stdio MCP server (src/server.js)
 * as a child process -- it is a second way to host it, not a replacement.
 * `npm start` keeps running src/server.js standalone, independent of the
 * registry.
 *
 * The transport is @majiwari/gateway's own `createStdioGatewayTransport`
 * (`gateway/src/stdio-target.js`), the same stdio transport convention any
 * gateway-routable adapter uses -- not a hand-rolled spawn. Its start()
 * resolves the explicit gateway-routable handle shape
 * (`gateway/src/gateway-transport.js`: a connected `mcpClient` plus the
 * `serverVersion`/`serverCapabilities` it negotiated), so this adapter can
 * be published through `createRegistryGateway` at `/mcp/inari` with no
 * Inari-specific code in `gateway/` or `registry/`.
 */
export function createManifest({ repo } = {}) {
  const transport = createStdioGatewayTransport({
    command: process.execPath,
    args: repo ? [SERVER_ENTRY, "--repo", repo] : [SERVER_ENTRY]
  });
  let resource;

  return {
    schemaVersion: "1",
    id: ADAPTER_ID,
    version: ADAPTER_VERSION,
    displayName: "Inari",
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
    // Re-derives Inari's own compatibility (installed version/protocol) and
    // GitHub auth deterministically on every call rather than asking the
    // running child, and strips `repo_root` (an absolute host filesystem
    // path) before returning, since this detail feeds the generic registry
    // health/status contract, which is public surface: it must never leak
    // a local filesystem path, unlike the `adapter_health` MCP tool's own
    // documented output, which keeps it.
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
    },
    capabilities: ["github-governance", "issue-tracking", "pull-request", "template-discovery"]
  };
}
