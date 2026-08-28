import { createStdioGatewayTransport } from "@majiwari/gateway";

export const ADAPTER_ID = "mottainai";
export const ADAPTER_VERSION = "0.1.0";
export const DEFAULT_MOTTAINAI_MCP_COMMAND = "mottainai-mcp";

const CAPABILITIES_TOOL = "mottainai_harness_capabilities";
const REQUIRED_WORK_TOOLS = Object.freeze([
  "mottainai_delegate_work",
  "mottainai_inspect_work",
  "mottainai_continue_work",
  "mottainai_cancel_work"
]);
const REQUIRED_TOOLS = Object.freeze([...REQUIRED_WORK_TOOLS, CAPABILITIES_TOOL]);

function incompatibleContract() {
  return new Error("installed mottainai-mcp does not satisfy the supported native harness MCP contract");
}

function hasRequiredTools(tools) {
  const names = new Set(tools.map((tool) => tool?.name).filter((name) => typeof name === "string"));
  return REQUIRED_TOOLS.every((name) => names.has(name));
}

function hasCompatibleCapabilities(result) {
  if (result?.isError === true) return false;
  const capabilities = result?.structuredContent?.capabilities;
  if (!capabilities || typeof capabilities !== "object" || Array.isArray(capabilities)) return false;
  if (capabilities.schemaVersion !== 1) return false;
  if (capabilities.protocol !== "mcp" || capabilities.transport !== "stdio") return false;
  if (capabilities.executable !== DEFAULT_MOTTAINAI_MCP_COMMAND) return false;
  if (!Array.isArray(capabilities.tools)) return false;
  const advertised = new Set(capabilities.tools);
  return REQUIRED_WORK_TOOLS.every((name) => advertised.has(name));
}

async function assertCompatibleResource(resource) {
  if (resource?.serverVersion?.name !== "mottainai-mcp") throw incompatibleContract();
  const { tools } = await resource.mcpClient.listTools();
  if (!Array.isArray(tools) || !hasRequiredTools(tools)) throw incompatibleContract();
  const capabilities = await resource.mcpClient.callTool({
    name: CAPABILITIES_TOOL,
    arguments: { schemaVersion: 1 }
  });
  if (!hasCompatibleCapabilities(capabilities)) throw incompatibleContract();
}

/**
 * Build the trusted Mottainai resident adapter. Majiwari owns only process,
 * registry, gateway, and route lifecycle. Mottainai remains authoritative
 * for every harness tool/schema/result/lifecycle semantic.
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
        const started = await transport.start();
        try {
          await assertCompatibleResource(started);
          resource = started;
          return started;
        } catch {
          await transport.stop(started).catch(() => {});
          resource = undefined;
          throw incompatibleContract();
        }
      },
      stop: async (handle) => {
        await transport.stop(handle);
        resource = undefined;
      }
    },
    listTools: async () => {
      if (!resource) return [];
      const { tools } = await resource.mcpClient.listTools();
      return tools;
    }
  };
}
