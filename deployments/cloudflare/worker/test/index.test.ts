import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AuthRequest, ClientInfo, OAuthHelpers } from "@cloudflare/workers-oauth-provider";

vi.mock("@cloudflare/workers-oauth-provider", () => ({
  AuthorizationError: class AuthorizationError extends Error {
    code = "invalid_request";
    description = this.message;
  },
  OAuthProvider: class OAuthProvider {
    constructor(_options: unknown) {}
  }
}));
vi.mock("../src/access", () => ({ authenticateOperator: vi.fn() }));

import { authenticateOperator } from "../src/access";
import { defaultHandler } from "../src/index";

class MemoryKV {
  private readonly values = new Map<string, string>();

  async put(key: string, value: string): Promise<void> {
    this.values.set(key, value);
  }

  async get<T>(key: string, type: "json"): Promise<T | null> {
    const value = this.values.get(key);
    return value ? (JSON.parse(value) as T) : null;
  }

  async delete(key: string): Promise<void> {
    this.values.delete(key);
  }
}

const oauthRequest: AuthRequest = {
  responseType: "code",
  clientId: "inspector-client",
  redirectUri: "https://client.example/callback",
  scope: ["mcp:invoke"],
  state: "client-state",
  codeChallenge: "challenge",
  codeChallengeMethod: "S256"
};

const client = {
  clientId: oauthRequest.clientId,
  clientName: "MCP Inspector",
  redirectUris: [oauthRequest.redirectUri],
  tokenEndpointAuthMethod: "none"
} satisfies ClientInfo;

function environment(provider: Partial<OAuthHelpers> = {}) {
  return {
    OAUTH_KV: new MemoryKV() as unknown as KVNamespace,
    OAUTH_PROVIDER: {
      parseAuthRequest: vi.fn(async () => oauthRequest),
      lookupClient: vi.fn(async () => client),
      completeAuthorization: vi.fn(async () => ({ redirectTo: "https://client.example/callback?code=one&state=client-state" })),
      ...provider
    } as unknown as OAuthHelpers,
    GATEWAY_ORIGIN: "https://gateway.example/mcp",
    ACCESS_TEAM_DOMAIN: "https://team.cloudflareaccess.com",
    ACCESS_AUDIENCE: "audience",
    OPERATOR_EMAIL: "operator@example.com"
  };
}

function getConsentFields(body: string): { state: string; csrfToken: string } {
  const state = body.match(/name="consent_state" value="([^"]+)"/)?.[1];
  const csrfToken = body.match(/name="csrf_token" value="([^"]+)"/)?.[1];
  if (!state || !csrfToken) throw new Error("consent fields missing");
  return { state, csrfToken };
}

function handle(request: Request, env: unknown): Promise<Response> {
  return Promise.resolve(defaultHandler.fetch!(request as never, env as never, {} as ExecutionContext));
}

describe("/authorize", () => {
  beforeEach(() => {
    vi.mocked(authenticateOperator).mockResolvedValue({ subject: "operator-subject", email: "operator@example.com" });
  });

  it("shows consent on GET and completes only after an approved POST", async () => {
    const env = environment();
    const provider = env.OAUTH_PROVIDER as unknown as {
      completeAuthorization: ReturnType<typeof vi.fn>;
    };

    const getResponse = await handle(new Request("https://mcp.example/authorize?code=oauth"), env);
    const body = await getResponse.text();
    const fields = getConsentFields(body);
    expect(getResponse.status).toBe(200);
    expect(body).toContain("MCP Inspector");
    expect(body).toContain("mcp:invoke");
    expect(provider.completeAuthorization).not.toHaveBeenCalled();

    const cookie = getResponse.headers.get("Set-Cookie")?.split(";")[0];
    const postResponse = await handle(
      new Request("https://mcp.example/authorize", {
        method: "POST",
        headers: { Cookie: cookie ?? "", "Content-Type": "application/x-www-form-urlencoded" },
        body: `consent_state=${fields.state}&csrf_token=${fields.csrfToken}&decision=approve`
      }),
      env as never
    );
    expect(postResponse.status).toBe(302);
    expect(provider.completeAuthorization).toHaveBeenCalledOnce();

    const replayResponse = await handle(
      new Request("https://mcp.example/authorize", {
        method: "POST",
        headers: { Cookie: cookie ?? "", "Content-Type": "application/x-www-form-urlencoded" },
        body: `consent_state=${fields.state}&csrf_token=${fields.csrfToken}&decision=approve`
      }),
      env as never
    );
    expect(replayResponse.status).toBe(400);
    expect(provider.completeAuthorization).toHaveBeenCalledOnce();
  });

  it("rejects CSRF and denied consent without creating a grant", async () => {
    const env = environment();
    const provider = env.OAUTH_PROVIDER as unknown as { completeAuthorization: ReturnType<typeof vi.fn> };
    const getResponse = await handle(new Request("https://mcp.example/authorize"), env);
    const fields = getConsentFields(await getResponse.text());
    const cookie = getResponse.headers.get("Set-Cookie")?.split(";")[0] ?? "";

    const csrfResponse = await handle(
      new Request("https://mcp.example/authorize", {
        method: "POST",
        headers: { Cookie: cookie, "Content-Type": "application/x-www-form-urlencoded" },
        body: `consent_state=${fields.state}&csrf_token=wrong&decision=approve`
      }),
      env as never
    );
    expect(csrfResponse.status).toBe(400);
    expect(provider.completeAuthorization).not.toHaveBeenCalled();

    const denyResponse = await handle(
      new Request("https://mcp.example/authorize", {
        method: "POST",
        headers: { Cookie: cookie, "Content-Type": "application/x-www-form-urlencoded" },
        body: `consent_state=${fields.state}&csrf_token=${fields.csrfToken}&decision=deny`
      }),
      env as never
    );
    expect(denyResponse.status).toBe(302);
    expect(new URL(denyResponse.headers.get("Location") ?? "").searchParams.get("error")).toBe("access_denied");
    expect(provider.completeAuthorization).not.toHaveBeenCalled();
  });

  it("fails closed when Access identity policy rejects the request", async () => {
    vi.mocked(authenticateOperator).mockResolvedValue(null);
    const env = environment();
    const response = await handle(new Request("https://mcp.example/authorize"), env);

    expect(response.status).toBe(403);
    expect((env.OAUTH_PROVIDER as unknown as { completeAuthorization: ReturnType<typeof vi.fn> }).completeAuthorization).not.toHaveBeenCalled();
  });
});
