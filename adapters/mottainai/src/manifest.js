import { createStdioGatewayTransport } from "@majiwari/gateway";

export const ADAPTER_ID = "mottainai";
export const ADAPTER_VERSION = "0.1.0";

/**
 * The packaged entrypoint name Mottainai's own launch/discovery contract
 * documents (yohn-jp/mottainai#548, `docs/mcp-harness-delegation.md`):
 * published in that package's `bin` map, backed by `dist/mcp.js`, resolved
 * from PATH like any other installed CLI. Never taken from resident config
 * -- the trusted catalog (`runtime/src/catalog.js`) is the only composition
 * edge allowed to choose it, and it is fixed here rather than accepting an
 * arbitrary command, so an operator config can select *whether* this
 * adapter runs but never *what* it executes. The environment override below
 * exists only for local development/testing against a non-PATH build.
 */
export const DEFAULT_MOTTAINAI_MCP_COMMAND = process.env.MAJIWARI_MOTTAINAI_MCP_COMMAND || "mottainai-mcp";

/**
 * Build the @majiwari/registry manifest for the Mottainai adapter.
 *
 * This adapter is gateway/transport only, per #56: it launches Mottainai's
 * own packaged, documented `mottainai-mcp` stdio entrypoint as a child
 * process and republishes whatever tools it advertises unchanged, through
 * the exact same generic stdio transport/gateway convention every other
 * adapter uses (`gateway/src/stdio-target.js` / `gateway/src/registry-
 * gateway.js`). It never imports a Mottainai module, never reads Mottainai
 * source-tree paths, and never re-implements or reinterprets delegation/
 * lifecycle/idempotency semantics -- tool discovery, invocation, and results
 * are read live from the connected `mcpClient`, the same client the gateway
 * bridges downstream MCP sessions onto, and schema/capability/version
 * metadata is whatever that client negotiated. Mottainai remains sole
 * authority for `mottainai_delegate_work`, `mottainai_inspect_work`,
 * `mottainai_continue_work`, `mottainai_cancel_work`, and
 * `mottainai_harness_capabilities`.
 *
 * `config`, when given, is passed straight through as `--config <path>`,
 * the one optional selector Mottainai's own launch contract documents. No
 * other flag, environment variable, or module path is accepted here.
 */
export function createManifest({ config, stderr = "ignore" } = {}) {
  const transport = createStdioGatewayTransport({
    command: DEFAULT_MOTTAINAI_MCP_COMMAND,
    args: config ? ["--config", config] : [],
    stderr
  });
  let resource;

  return {
    schemaVersion: "1",
    id: ADAPTER_ID,
    version: ADAPTER_VERSION,
    displayName: "Mottainai",
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
    // Generic tool discovery for the registry/gateway contract only: while
    // the adapter is running, ask its own connected mcpClient (the same one
    // gateway routing uses) for its live tool list via the MCP protocol,
    // rather than maintaining a second, hand-kept copy of Mottainai's tool
    // names/schemas here. No manifest-level `health()` is declared -- unlike
    // OCR/Inari, this adapter has no domain-specific compatibility check of
    // its own to run; the registry's own lifecycle state (registered/
    // running/errored) is already the correct, redaction-safe signal for a
    // pure passthrough adapter.
    listTools: async () => {
      if (!resource) return [];
      const { tools } = await resource.mcpClient.listTools();
      return tools;
    }
  };
}
