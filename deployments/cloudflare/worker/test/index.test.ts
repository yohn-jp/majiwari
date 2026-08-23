import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../src/access", () => ({ verifyAccessAssertion: vi.fn() }));

import { verifyAccessAssertion } from "../src/access";
import worker, { type Env } from "../src/index";

function environment(overrides: Partial<Env> = {}): Env {
  return {
    GATEWAY_ORIGIN: "https://gateway.example/mcp",
    GATEWAY_ACCESS_CLIENT_ID: "worker-client-id",
    GATEWAY_ACCESS_CLIENT_SECRET: "worker-client-secret",
    MCP_ACCESS_TEAM_DOMAIN: "https://team.cloudflareaccess.com",
    MCP_ACCESS_AUDIENCE: "mcp-audience",
    ...overrides
  };
}

function handle(request: Request, env: Env): Promise<Response> {
  return Promise.resolve(worker.fetch!(request as never, env, {} as ExecutionContext));
}

describe("routing", () => {
  it("serves /health without requiring an Access assertion", async () => {
    const response = await handle(new Request("https://mcp.example/health"), environment());
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true });
    expect(verifyAccessAssertion).not.toHaveBeenCalled();
  });

  it("returns 404 for every other path, including retired OAuth endpoints", async () => {
    for (const path of ["/", "/authorize", "/oauth/token", "/oauth/register", "/.well-known/oauth-authorization-server"]) {
      const response = await handle(new Request(`https://mcp.example${path}`), environment());
      expect(response.status).toBe(404);
    }
  });
});

describe("/mcp", () => {
  beforeEach(() => {
    vi.mocked(verifyAccessAssertion).mockReset();
  });

  it("denies the request when Cloudflare Access rejects or omits the assertion", async () => {
    vi.mocked(verifyAccessAssertion).mockResolvedValue(null);
    const fetchSpy = vi.spyOn(globalThis, "fetch");

    const response = await handle(new Request("https://mcp.example/mcp"), environment());

    expect(response.status).toBe(403);
    expect(fetchSpy).not.toHaveBeenCalled();
    fetchSpy.mockRestore();
  });

  it("forwards an authenticated request to the gateway origin over the protected Tunnel", async () => {
    vi.mocked(verifyAccessAssertion).mockResolvedValue({ subject: "user-subject", email: "user@example.com" });
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("ok", { status: 200 }));

    const response = await handle(
      new Request("https://mcp.example/mcp", { headers: { "Cf-Access-Jwt-Assertion": "assertion-token" } }),
      environment()
    );

    expect(response.status).toBe(200);
    expect(fetchSpy).toHaveBeenCalledOnce();
    const [target, init] = fetchSpy.mock.calls[0];
    expect(target.toString()).toBe("https://gateway.example/mcp");
    const headers = init?.headers as Headers;
    expect(headers.get("cf-access-client-id")).toBe("worker-client-id");
    expect(headers.get("cf-access-client-secret")).toBe("worker-client-secret");
    fetchSpy.mockRestore();
  });
});
