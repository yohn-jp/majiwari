import { describe, expect, it } from "vitest";
import { buildProxyTarget, filterHeaders } from "../src/proxy";

describe("buildProxyTarget", () => {
  it("rewrites the path and query onto the gateway origin, never the origin's own path", () => {
    const target = buildProxyTarget("https://mcp.example.com/mcp?foo=bar", "https://internal.example/mcp");
    expect(target.toString()).toBe("https://internal.example/mcp?foo=bar");
  });

  it("preserves a gateway origin path prefix", () => {
    const target = buildProxyTarget("https://mcp.example.com/mcp", "https://internal.example/prefix/mcp");
    expect(target.pathname).toBe("/mcp");
  });

  it("never leaks the public request host into the target", () => {
    const target = buildProxyTarget("https://mcp.example.com/mcp", "https://internal.example/mcp");
    expect(target.host).toBe("internal.example");
  });
});

describe("filterHeaders", () => {
  it("drops hop-by-hop headers", () => {
    const source = new Headers({
      "content-type": "application/json",
      connection: "keep-alive",
      host: "mcp.example.com",
      "transfer-encoding": "chunked"
    });
    const filtered = filterHeaders(source);
    expect(filtered.get("content-type")).toBe("application/json");
    expect(filtered.has("connection")).toBe(false);
    expect(filtered.has("host")).toBe(false);
    expect(filtered.has("transfer-encoding")).toBe(false);
  });

  it("preserves MCP session and protocol headers unmodified", () => {
    const source = new Headers({
      "mcp-session-id": "abc-123",
      "mcp-protocol-version": "2026-06-18",
      authorization: "Bearer token"
    });
    const filtered = filterHeaders(source);
    expect(filtered.get("mcp-session-id")).toBe("abc-123");
    expect(filtered.get("mcp-protocol-version")).toBe("2026-06-18");
    expect(filtered.get("authorization")).toBe("Bearer token");
  });
});
