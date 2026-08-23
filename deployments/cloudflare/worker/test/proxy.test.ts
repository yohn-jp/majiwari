import { describe, expect, it } from "vitest";
import { buildProxyTarget, filterHeaders, withServiceToken } from "../src/proxy";

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

describe("withServiceToken", () => {
  it("injects only configured credentials and preserves required MCP headers", () => {
    const source = new Headers({
      accept: "application/json, text/event-stream",
      "content-type": "application/json",
      "mcp-session-id": "abc-123",
      authorization: "Bearer client-token",
      "cf-access-client-id": "client-id",
      "cf-access-client-secret": "client-secret"
    });

    const upstream = withServiceToken(source, "worker-client-id", "worker-client-secret");

    expect(upstream.get("accept")).toBe("application/json, text/event-stream");
    expect(upstream.get("content-type")).toBe("application/json");
    expect(upstream.get("mcp-session-id")).toBe("abc-123");
    expect(upstream.get("cf-access-client-id")).toBe("worker-client-id");
    expect(upstream.get("cf-access-client-secret")).toBe("worker-client-secret");
    expect(upstream.get("authorization")).toBe(null);
  });

  it("fails closed when either service-token secret is missing", () => {
    expect(() => withServiceToken(new Headers(), "", "secret")).toThrow(
      "Gateway Access service-token secrets are not configured"
    );
  });
});
