import { DurableObject } from "cloudflare:workers";
import type { AuthRequest, ClientInfo } from "@cloudflare/workers-oauth-provider";
import type { OperatorIdentity } from "./access";

export const CONSENT_COOKIE = "__Host-majiwari-consent";
export const CONSENT_TTL_SECONDS = 600;

const CONSENT_RECORD_KEY = "record";

export interface ConsentState {
  state: string;
  request: AuthRequest;
  clientId: string;
  operator: OperatorIdentity;
  csrfToken: string;
  expiresAt: number;
}

interface ConsentConsumptionRequest {
  state: string;
  csrfToken: string;
  operatorSubject: string;
  operatorEmail: string;
}

function randomToken(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function isValidConsentState(value: unknown, expectedState?: string): value is ConsentState {
  if (!value || typeof value !== "object") return false;
  const record = value as Partial<ConsentState>;
  if (
    typeof record.state !== "string" ||
    (expectedState !== undefined && record.state !== expectedState) ||
    typeof record.clientId !== "string" ||
    typeof record.csrfToken !== "string" ||
    !Number.isFinite(record.expiresAt) ||
    !record.request ||
    !record.operator
  ) {
    return false;
  }

  const request = record.request as Partial<AuthRequest>;
  const operator = record.operator as Partial<OperatorIdentity>;
  return (
    typeof request.responseType === "string" &&
    typeof request.clientId === "string" &&
    request.clientId === record.clientId &&
    typeof request.redirectUri === "string" &&
    typeof request.state === "string" &&
    Array.isArray(request.scope) &&
    request.scope.every((scope) => typeof scope === "string") &&
    typeof operator.subject === "string" &&
    typeof operator.email === "string"
  );
}

function jsonError(status: number, message: string): Response {
  return new Response(message, { status, headers: { "Cache-Control": "no-store" } });
}

/**
 * Durable Object that owns one consent state. `consume` uses a storage
 * transaction so concurrent redemption requests cannot both observe a live
 * record and complete authorization.
 */
export class ConsentStateDurableObject extends DurableObject {
  async fetch(request: Request): Promise<Response> {
    const path = new URL(request.url).pathname;

    try {
      if (request.method === "PUT" && path === "/state") {
        const record = (await request.json()) as unknown;
        if (!isValidConsentState(record) || record.expiresAt <= Date.now()) return jsonError(400, "Invalid consent state");

        const created = await this.ctx.storage.transaction(async (transaction) => {
          const existing = await transaction.get<ConsentState>(CONSENT_RECORD_KEY);
          if (isValidConsentState(existing) && existing.expiresAt > Date.now()) return false;
          if (existing) await transaction.delete(CONSENT_RECORD_KEY);
          await transaction.put(CONSENT_RECORD_KEY, record);
          return true;
        });
        if (!created) return jsonError(409, "Consent state already exists");

        // Expiry is also checked in every read/consume transaction. The alarm
        // only removes abandoned records after their ten-minute lifetime.
        await this.ctx.storage.setAlarm(record.expiresAt);
        return new Response(null, { status: 201 });
      }

      if (request.method === "GET" && path === "/state") {
        const record = await this.ctx.storage.transaction(async (transaction) => {
          const current = await transaction.get<ConsentState>(CONSENT_RECORD_KEY);
          if (!isValidConsentState(current) || current.expiresAt <= Date.now()) {
            if (current) await transaction.delete(CONSENT_RECORD_KEY);
            return null;
          }
          return current;
        });
        return record ? Response.json(record, { headers: { "Cache-Control": "no-store" } }) : jsonError(404, "Consent state not found");
      }

      if (request.method === "POST" && path === "/consume") {
        const consumption = (await request.json()) as Partial<ConsentConsumptionRequest>;
        const record = await this.ctx.storage.transaction(async (transaction) => {
          const current = await transaction.get<ConsentState>(CONSENT_RECORD_KEY);
          if (!isValidConsentState(current) || current.expiresAt <= Date.now()) {
            if (current) await transaction.delete(CONSENT_RECORD_KEY);
            return null;
          }
          if (
            consumption.state !== current.state ||
            consumption.csrfToken !== current.csrfToken ||
            consumption.operatorSubject !== current.operator.subject ||
            consumption.operatorEmail !== current.operator.email
          ) {
            return null;
          }

          await transaction.delete(CONSENT_RECORD_KEY);
          return current;
        });
        return record ? Response.json(record, { headers: { "Cache-Control": "no-store" } }) : jsonError(404, "Consent state not found");
      }
    } catch {
      return jsonError(400, "Invalid consent state");
    }

    return jsonError(404, "Not found");
  }

  async alarm(): Promise<void> {
    await this.ctx.storage.delete(CONSENT_RECORD_KEY);
  }
}

function consentStub(namespace: DurableObjectNamespace, state: string): DurableObjectStub {
  return namespace.get(namespace.idFromName(state));
}

async function responseConsentState(response: Response, expectedState: string): Promise<ConsentState | null> {
  if (response.status === 404) return null;
  if (!response.ok) throw new Error(`consent state operation failed: ${response.status}`);
  const record = (await response.json()) as unknown;
  return isValidConsentState(record, expectedState) ? record : null;
}

export async function createConsentState(
  namespace: DurableObjectNamespace,
  request: AuthRequest,
  operator: OperatorIdentity
): Promise<{ state: string; csrfToken: string }> {
  const state = randomToken();
  const csrfToken = randomToken();
  const record: ConsentState = {
    state,
    request,
    clientId: request.clientId,
    operator,
    csrfToken,
    expiresAt: Date.now() + CONSENT_TTL_SECONDS * 1000
  };
  const response = await consentStub(namespace, state).fetch(
    new Request("https://consent/state", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(record)
    })
  );
  if (!response.ok) throw new Error(`consent state creation failed: ${response.status}`);
  return { state, csrfToken };
}

export async function loadConsentState(namespace: DurableObjectNamespace, state: string): Promise<ConsentState | null> {
  if (!/^[A-Za-z0-9_-]{40,}$/.test(state)) return null;
  return responseConsentState(await consentStub(namespace, state).fetch(new Request("https://consent/state")), state);
}

/**
 * Atomically validates the operator binding and removes the state. A null
 * result means expired, invalid, or already consumed; callers must not grant.
 */
export async function consumeConsentState(
  namespace: DurableObjectNamespace,
  state: string,
  csrfToken: string,
  operator: OperatorIdentity
): Promise<ConsentState | null> {
  if (!/^[A-Za-z0-9_-]{40,}$/.test(state)) return null;
  const response = await consentStub(namespace, state).fetch(
    new Request("https://consent/consume", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ state, csrfToken, operatorSubject: operator.subject, operatorEmail: operator.email })
    })
  );
  return responseConsentState(response, state);
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
