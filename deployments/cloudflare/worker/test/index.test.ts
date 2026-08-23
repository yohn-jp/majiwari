import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../src/access", () => ({ verifyAccessAssertion: vi.fn() }));

import { verifyAccessAssertion } from "../src/access";
import worker, { type Env } from "../src/index";

function environment(overrides: Partial<Env> = {}): Env {
  return {
    GATEWAY_VPC: { fetch: vi.fn() } as unknown as Fetcher,
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
    const env = environment();

    const response = await handle(new Request("https://mcp.example/mcp"), env);

    expect(response.status).toBe(403);
    expect(env.GATEWAY_VPC.fetch).not.toHaveBeenCalled();
  });

  it("forwards an authenticated request to the gateway over the Workers VPC Service binding", async () => {
    vi.mocked(verifyAccessAssertion).mockResolvedValue({ subject: "user-subject", email: "user@example.com" });
    const env = environment();
    vi.mocked(env.GATEWAY_VPC.fetch).mockResolvedValue(new Response("ok", { status: 200 }));

    const response = await handle(
      new Request("https://mcp.example/mcp", { headers: { "Cf-Access-Jwt-Assertion": "assertion-token" } }),
      env
    );

    expect(response.status).toBe(200);
    expect(env.GATEWAY_VPC.fetch).toHaveBeenCalledOnce();
    const [target] = vi.mocked(env.GATEWAY_VPC.fetch).mock.calls[0];
    expect((target as Request).toString()).toBe("http://127.0.0.1:8787/mcp");
  });
});
