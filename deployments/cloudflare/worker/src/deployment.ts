/**
 * Wrangler replaces this identifier during a profile-driven deployment.
 * The neutral fallback keeps local tests and typechecking independent of a
 * deployment account.
 */
declare const __MAJIWARI_PUBLIC_MCP_URL__: string | undefined;

export const DEFAULT_PUBLIC_MCP_URL = "https://mcp.example.invalid/mcp";

const buildPublicMcpUrl =
  typeof __MAJIWARI_PUBLIC_MCP_URL__ === "string" ? __MAJIWARI_PUBLIC_MCP_URL__ : undefined;

export const PUBLIC_MCP_URL = buildPublicMcpUrl ?? DEFAULT_PUBLIC_MCP_URL;

export interface ResourceMetadata {
  resource: string;
  authorization_servers: string[];
  scopes_supported: string[];
  resource_name: string;
}

/** Build OAuth metadata from the same canonical URL clients register. */
export function createResourceMetadata(publicMcpUrl: string): ResourceMetadata {
  return {
    resource: publicMcpUrl,
    authorization_servers: [new URL(publicMcpUrl).origin],
    scopes_supported: ["mcp:invoke"],
    resource_name: "Majiwari MCP gateway"
  };
}

export const RESOURCE_METADATA = createResourceMetadata(PUBLIC_MCP_URL);
