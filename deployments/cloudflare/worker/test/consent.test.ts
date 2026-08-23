import { describe, expect, it } from "vitest";
import type { AuthRequest, ClientInfo } from "@cloudflare/workers-oauth-provider";
import {
  CONSENT_COOKIE,
  CONSENT_TTL_SECONDS,
  consumeConsentState,
  createConsentState,
  getConsentCookie,
  isValidConsentSubmission,
  loadConsentState,
  parseConsentForm,
  renderConsentPage
} from "../src/consent";
import { MemoryConsentNamespace } from "./consent-fixture";

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

function namespace(): DurableObjectNamespace {
  return new MemoryConsentNamespace().asNamespace();
}

describe("consent state", () => {
  it("stores the parsed OAuth request and consumes it once", async () => {
    const store = namespace();
    const created = await createConsentState(store, oauthRequest, operator);

    expect(created.state).toMatch(/^[A-Za-z0-9_-]{40,}$/);
    expect(created.csrfToken).toMatch(/^[A-Za-z0-9_-]{40,}$/);
    const loaded = await loadConsentState(store, created.state);
    expect(loaded?.request).toEqual(oauthRequest);
    expect(loaded?.expiresAt).toBeGreaterThan(Date.now() + (CONSENT_TTL_SECONDS - 1) * 1000);

    expect(await consumeConsentState(store, created.state, created.csrfToken, operator)).not.toBeNull();
    expect(await loadConsentState(store, created.state)).toBeNull();
  });

  it("accepts only a matching form token, consent cookie, and operator identity", async () => {
    const store = namespace();
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
    const store = new MemoryConsentNamespace();
    const state = "valid-state-with-enough-length-1234567890";
    const response = await store.get(state).fetch(
      new Request("https://consent/state", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ state: "different-state", request: { clientId: "client" }, clientId: "client", operator, csrfToken: "token" })
      })
    );
    expect(response.status).toBe(400);
    expect(await loadConsentState(store.asNamespace(), state)).toBeNull();
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
