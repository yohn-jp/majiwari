import { describe, expect, it } from "vitest";
import type { AuthRequest, ClientInfo } from "@cloudflare/workers-oauth-provider";
import {
  CONSENT_COOKIE,
  consumeConsentState,
  createConsentState,
  getConsentCookie,
  isValidConsentSubmission,
  loadConsentState,
  parseConsentForm,
  renderConsentPage
} from "../src/consent";

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
  codeChallengeMethod: "S256",
  issuer: "https://mcp.example"
};

const operator = { subject: "access-subject", email: "operator@example.com" };

function kv(): KVNamespace {
  return new MemoryKV() as unknown as KVNamespace;
}

describe("consent state", () => {
  it("stores the parsed OAuth request and consumes it once", async () => {
    const store = kv();
    const created = await createConsentState(store, oauthRequest, operator);

    expect(created.state).toMatch(/^[A-Za-z0-9_-]{40,}$/);
    expect(created.csrfToken).toMatch(/^[A-Za-z0-9_-]{40,}$/);
    expect((await loadConsentState(store, created.state))?.request).toEqual(oauthRequest);

    await consumeConsentState(store, created.state);
    expect(await loadConsentState(store, created.state)).toBeNull();
  });

  it("accepts only a matching form token, consent cookie, and operator identity", async () => {
    const store = kv();
    const created = await createConsentState(store, oauthRequest, operator);
    const consent = await loadConsentState(store, created.state);
    if (!consent) throw new Error("consent state was not stored");

    const validRequest = new Request("https://mcp.example/authorize", {
      method: "POST",
      headers: {
        Cookie: `${CONSENT_COOKIE}=${created.csrfToken}`,
        "Content-Type": "application/x-www-form-urlencoded"
      },
      body: `consent_state=${created.state}&csrf_token=${created.csrfToken}&decision=approve`
    });
    const form = await parseConsentForm(validRequest);
    expect(form).toEqual({ state: created.state, csrfToken: created.csrfToken, decision: "approve" });
    expect(form && isValidConsentSubmission(validRequest, form, consent, operator)).toBe(true);

    const wrongToken = new Request(validRequest, {
      headers: {
        Cookie: `${CONSENT_COOKIE}=wrong-token`,
        "Content-Type": "application/x-www-form-urlencoded"
      },
      body: `consent_state=${created.state}&csrf_token=wrong-token&decision=approve`
    });
    const wrongForm = await parseConsentForm(wrongToken);
    expect(wrongForm && isValidConsentSubmission(wrongToken, wrongForm, consent, operator)).toBe(false);

    expect(isValidConsentSubmission(validRequest, form!, consent, { subject: "other", email: operator.email })).toBe(false);
  });

  it("rejects a tampered state record", async () => {
    const store = new MemoryKV();
    await store.put(
      "oauth-consent-valid-state-with-enough-length-1234567890",
      JSON.stringify({ state: "different-state", request: { clientId: "client" }, clientId: "client", operator, csrfToken: "token" })
    );
    expect(await loadConsentState(store as unknown as KVNamespace, "valid-state-with-enough-length-1234567890")).toBeNull();
  });
});

describe("consent page", () => {
  it("identifies the client and scopes without allowing HTML injection", async () => {
    const client = {
      clientId: "client<&",
      clientName: "<unsafe>",
      redirectUris: [oauthRequest.redirectUri],
      tokenEndpointAuthMethod: "none"
    } satisfies ClientInfo;
    const response = renderConsentPage(client, ["mcp:invoke", "<scope>"], "state", "csrf");
    const body = await response.text();

    expect(response.status).toBe(200);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    expect(response.headers.get("Set-Cookie")).toContain(`${CONSENT_COOKIE}=csrf`);
    expect(body).toContain("&lt;unsafe&gt;");
    expect(body).toContain("client&lt;&amp;");
    expect(body).toContain("mcp:invoke");
    expect(body).toContain("&lt;scope&gt;");
    expect(body).toContain('name="decision" value="approve"');
    expect(body).toContain('name="decision" value="deny"');
  });

  it("rejects non-form submissions", async () => {
    const form = await parseConsentForm(new Request("https://mcp.example/authorize", { method: "GET" }));
    expect(form).toBeNull();
    expect(getConsentCookie(new Request("https://mcp.example/authorize"))).toBeNull();
  });
});
