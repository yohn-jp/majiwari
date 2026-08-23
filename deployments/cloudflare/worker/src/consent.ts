import type { AuthRequest, ClientInfo } from "@cloudflare/workers-oauth-provider";
import type { OperatorIdentity } from "./access";

export const CONSENT_COOKIE = "__Host-majiwari-consent";
export const CONSENT_TTL_SECONDS = 600;

export interface ConsentState {
  state: string;
  request: AuthRequest;
  clientId: string;
  operator: OperatorIdentity;
  csrfToken: string;
}

function randomToken(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function stateKey(state: string): string {
  return `oauth-consent:${state}`;
}

export async function createConsentState(kv: KVNamespace, request: AuthRequest, operator: OperatorIdentity): Promise<{ state: string; csrfToken: string }> {
  const state = randomToken();
  const csrfToken = randomToken();
  const record: ConsentState = { state, request, clientId: request.clientId, operator, csrfToken };
  await kv.put(stateKey(state), JSON.stringify(record), { expirationTtl: CONSENT_TTL_SECONDS });
  return { state, csrfToken };
}

export async function loadConsentState(kv: KVNamespace, state: string): Promise<ConsentState | null> {
  if (!/^[A-Za-z0-9_-]{40,}$/.test(state)) return null;
  const value = await kv.get(stateKey(state), "json");
  if (!value || typeof value !== "object") return null;

  const record = value as Partial<ConsentState>;
  if (record.state !== state || !record.request || record.clientId !== record.request.clientId || !record.operator || !record.csrfToken) return null;
  if (typeof record.csrfToken !== "string" || typeof record.operator.subject !== "string" || typeof record.operator.email !== "string") {
    return null;
  }
  const request = record.request as Partial<AuthRequest>;
  if (
    typeof request.responseType !== "string" ||
    typeof request.clientId !== "string" ||
    typeof request.redirectUri !== "string" ||
    typeof request.state !== "string" ||
    !Array.isArray(request.scope) ||
    request.scope.some((scope) => typeof scope !== "string")
  ) {
    return null;
  }
  return record as ConsentState;
}

export async function consumeConsentState(kv: KVNamespace, state: string): Promise<void> {
  await kv.delete(stateKey(state));
}

export function getConsentCookie(request: Request): string | null {
  const cookieHeader = request.headers.get("Cookie");
  if (!cookieHeader) return null;
  for (const cookie of cookieHeader.split(";")) {
    const separator = cookie.indexOf("=");
    if (separator === -1) continue;
    if (cookie.slice(0, separator).trim() === CONSENT_COOKIE) return cookie.slice(separator + 1).trim() || null;
  }
  return null;
}

export function isValidConsentSubmission(
  request: Request,
  form: { state: string; csrfToken: string },
  consent: ConsentState,
  operator: OperatorIdentity
): boolean {
  return (
    form.state === consent.state &&
    form.csrfToken === consent.csrfToken &&
    getConsentCookie(request) === consent.csrfToken &&
    operator.subject === consent.operator.subject &&
    operator.email === consent.operator.email
  );
}

export function parseConsentForm(request: Request): Promise<{ state: string; csrfToken: string; decision: "approve" | "deny" } | null> {
  if (request.method !== "POST" || !request.headers.get("Content-Type")?.toLowerCase().startsWith("application/x-www-form-urlencoded")) {
    return Promise.resolve(null);
  }

  return request
    .formData()
    .then((form) => {
      const state = form.get("consent_state");
      const csrfToken = form.get("csrf_token");
      const decision = form.get("decision");
      if (typeof state !== "string" || typeof csrfToken !== "string" || (decision !== "approve" && decision !== "deny")) return null;
      return { state, csrfToken, decision: decision as "approve" | "deny" };
    })
    .catch(() => null);
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>'"]/g, (character) => {
    switch (character) {
      case "&":
        return "&amp;";
      case "<":
        return "&lt;";
      case ">":
        return "&gt;";
      case "'":
        return "&#39;";
      default:
        return "&quot;";
    }
  });
}

export function renderConsentPage(client: ClientInfo, requestedScopes: string[], state: string, csrfToken: string): Response {
  const clientName = client.clientName?.trim() || client.clientId;
  const scopes = requestedScopes.map((scope) => `<li><code>${escapeHtml(scope)}</code></li>`).join("");
  const html = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <title>Authorize ${escapeHtml(clientName)}</title>
  </head>
  <body>
    <main>
      <h1>Authorize access</h1>
      <p><strong>Client:</strong> ${escapeHtml(clientName)}</p>
      <p><strong>Client ID:</strong> <code>${escapeHtml(client.clientId)}</code></p>
      <p>This client requests:</p>
      <ul>${scopes}</ul>
      <form method="post" action="/authorize">
        <input type="hidden" name="consent_state" value="${escapeHtml(state)}">
        <input type="hidden" name="csrf_token" value="${escapeHtml(csrfToken)}">
        <button type="submit" name="decision" value="approve">Approve</button>
        <button type="submit" name="decision" value="deny">Deny</button>
      </form>
    </main>
  </body>
</html>`;
  return new Response(html, {
    status: 200,
    headers: {
      "Cache-Control": "no-store",
      "Content-Security-Policy": "default-src 'none'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'",
      "Content-Type": "text/html; charset=utf-8",
      "Referrer-Policy": "no-referrer",
      "Set-Cookie": `${CONSENT_COOKIE}=${csrfToken}; Max-Age=${CONSENT_TTL_SECONDS}; Path=/; HttpOnly; Secure; SameSite=Lax`
    }
  });
}

export function clearConsentCookie(headers: Headers): void {
  headers.set("Set-Cookie", `${CONSENT_COOKIE}=; Max-Age=0; Path=/; HttpOnly; Secure; SameSite=Lax`);
}
