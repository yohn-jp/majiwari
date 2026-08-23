import { describe, expect, it } from "vitest";
import { DEFAULT_PUBLIC_MCP_URL, RESOURCE_METADATA, createResourceMetadata } from "../src/deployment";

describe("OAuth deployment metadata", () => {
  it("uses the canonical MCP resource URL and its public origin", () => {
    const metadata = createResourceMetadata("https://mcp.test/mcp");
    expect(metadata).toEqual({
      resource: "https://mcp.test/mcp",
      authorization_servers: ["https://mcp.test"],
      scopes_supported: ["mcp:invoke"],
      resource_name: "Majiwari MCP gateway"
    });
  });

  it("keeps a neutral fallback for local tests", () => {
    expect(RESOURCE_METADATA.resource).toBe(DEFAULT_PUBLIC_MCP_URL);
    expect(RESOURCE_METADATA.authorization_servers).toEqual(["https://mcp.example.invalid"]);
  });
});
