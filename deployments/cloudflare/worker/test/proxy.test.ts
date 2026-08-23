import { describe, expect, it } from "vitest";
import { buildProxyTarget, filterHeaders, GATEWAY_VPC_ADDRESS } from "../src/proxy";

describe("buildProxyTarget", () => {
  it("rewrites the path and query onto the gateway's fixed VPC Service address", () => {
    const target = buildProxyTarget("https://mcp.example.com/mcp?foo=bar");
    expect(target.toString()).toBe("http://127.0.0.1:8787/mcp?foo=bar");
  });

  it("never leaks the public request host into the target", () => {
    const target = buildProxyTarget("https://mcp.example.com/mcp");
    expect(target.host).toBe(new URL(GATEWAY_VPC_ADDRESS).host);
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

  it("strips client and origin authentication headers", () => {
    const source = new Headers({
      "mcp-session-id": "abc-123",
      "mcp-protocol-version": "2026-06-18",
      authorization: "Bearer client-token",
      "cf-access-client-id": "client-id",
      "cf-access-client-secret": "client-secret",
      "cf-access-jwt-assertion": "client-jwt",
      "x-forwarded-authorization": "Bearer forwarded-token"
    });
    const filtered = filterHeaders(source);
    expect(filtered.get("mcp-session-id")).toBe("abc-123");
    expect(filtered.get("mcp-protocol-version")).toBe("2026-06-18");
    expect(filtered.has("authorization")).toBe(false);
    expect(filtered.has("cf-access-client-id")).toBe(false);
    expect(filtered.has("cf-access-client-secret")).toBe(false);
    expect(filtered.has("cf-access-jwt-assertion")).toBe(false);
    expect(filtered.has("x-forwarded-authorization")).toBe(false);
  });
});
