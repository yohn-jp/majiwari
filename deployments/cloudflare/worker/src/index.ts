import { AuthorizationError, OAuthProvider, type AuthRequest } from "@cloudflare/workers-oauth-provider";
import { WorkerEntrypoint } from "cloudflare:workers";
import { authenticateOperator } from "./access";
import {
  clearConsentCookie,
  consumeConsentState,
  createConsentState,
  isValidConsentSubmission,
  loadConsentState,
  parseConsentForm,
  renderConsentPage
} from "./consent";
import { buildProxyTarget, filterHeaders, withServiceToken } from "./proxy";
import { isPublicRoute } from "./routes";

export interface Env {
  OAUTH_KV: KVNamespace;
  OAUTH_PROVIDER: import("@cloudflare/workers-oauth-provider").OAuthHelpers;
  /** Tunnel-internal origin for the Majiwari gateway. Never exposed to clients. */
  GATEWAY_ORIGIN: string;
  /** Cloudflare Access service-token client ID. Provision with `wrangler secret put`. */
  GATEWAY_ACCESS_CLIENT_ID: string;
  /** Cloudflare Access service-token client secret. Provision with `wrangler secret put`. */
  GATEWAY_ACCESS_CLIENT_SECRET: string;
  /** Cloudflare Access team issuer, for example https://team.cloudflareaccess.com. */
  ACCESS_TEAM_DOMAIN: string;
  /** Cloudflare Access application audience tag. */
  ACCESS_AUDIENCE: string;
  /** Email address allowed to approve the single-operator grant. */
  OPERATOR_EMAIL: string;
  /** Optional override for the Access certificate endpoint, useful for controlled deployments. */
  ACCESS_CERTS_URL?: string;
}

interface AuthProps {
  userId: string;
  operatorEmail: string;
  [key: string]: unknown;
}

/**
 * Proxies /mcp to the gateway's internal origin over the Tunnel. Never
 * rewrites MCP semantics (method, headers, streaming body, status) beyond
 * what's required to swap the origin and authenticate the Tunnel -- OAuth and
 * the Worker-owned Access service token are the only things added here.
 */
export class McpProxyHandler extends WorkerEntrypoint<Env, AuthProps> {
  async fetch(request: Request): Promise<Response> {
    const target = buildProxyTarget(request.url, this.env.GATEWAY_ORIGIN);

    const upstream = await fetch(target, {
      method: request.method,
      headers: withServiceToken(
        request.headers,
        this.env.GATEWAY_ACCESS_CLIENT_ID,
        this.env.GATEWAY_ACCESS_CLIENT_SECRET
      ),
      body: request.body,
      // @ts-expect-error -- Workers runtime requires this for streamed request bodies.
      duplex: request.body ? "half" : undefined
    });

    return new Response(upstream.body, { status: upstream.status, headers: filterHeaders(upstream.headers) });
  }
}

function oauthErrorResponse(error: unknown): Response {
  if (error instanceof AuthorizationError && error.redirectUri) {
    const redirect = new URL(error.redirectUri);
    redirect.searchParams.set("error", error.code);
    redirect.searchParams.set("error_description", error.description);
    if (error.state) redirect.searchParams.set("state", error.state);
    if (error.issuer) redirect.searchParams.set("iss", error.issuer);
    return Response.redirect(redirect.toString(), 302);
  }

  const description = error instanceof AuthorizationError ? error.description : error instanceof Error ? error.message : "invalid authorization request";
  return new Response(description, { status: 400 });
}

function accessDeniedResponse(request: AuthRequest): Response {
  const redirect = new URL(request.redirectUri);
  redirect.searchParams.set("error", "access_denied");
  redirect.searchParams.set("error_description", "operator denied access");
  redirect.searchParams.set("state", request.state);
  if (request.issuer) redirect.searchParams.set("iss", request.issuer);
  return oauthRedirectResponse(redirect.toString());
}

function oauthRedirectResponse(location: string): Response {
  return new Response(null, {
    status: 302,
    headers: { "Cache-Control": "no-store", Location: location }
  });
}

function operatorUserId(subject: string): string {
  return `access-${encodeURIComponent(subject)}`;
}

export const defaultHandler: ExportedHandler<Env> = {
  async fetch(request, env) {
    const url = new URL(request.url);
    const route = isPublicRoute(url.pathname);

    if (route === "health") {
      return Response.json({ ok: true });
    }

    if (route === "not-found") {
      return new Response("Not found", { status: 404 });
    }

    if (request.method !== "GET" && request.method !== "POST") {
      return new Response("Method not allowed", { status: 405, headers: { Allow: "GET, POST" } });
    }

    const operator = await authenticateOperator(request, env);
    if (!operator) {
      return new Response("Operator authentication or policy check failed", {
        status: 403,
        headers: { "Cache-Control": "no-store" }
      });
    }

    if (request.method === "GET") {
      let oauthRequest: AuthRequest;
      try {
        oauthRequest = await env.OAUTH_PROVIDER.parseAuthRequest(request);
      } catch (error) {
        return oauthErrorResponse(error);
      }

      const client = await env.OAUTH_PROVIDER.lookupClient(oauthRequest.clientId);
      if (!client) return new Response("Unknown OAuth client", { status: 400 });

      const consent = await createConsentState(env.OAUTH_KV, oauthRequest, operator);
      return renderConsentPage(client, oauthRequest.scope, consent.state, consent.csrfToken);
    }

    const form = await parseConsentForm(request);
    if (!form) return new Response("Invalid consent submission", { status: 400 });

    const consent = await loadConsentState(env.OAUTH_KV, form.state);
    if (!consent) return new Response("Invalid or expired consent state", { status: 400 });
    if (!isValidConsentSubmission(request, form, consent, operator)) return new Response("Invalid consent state", { status: 400 });

    // Consume before either denial or grant completion. A submitted consent state is one-use.
    await consumeConsentState(env.OAUTH_KV, form.state);

    if (form.decision === "deny") {
      const response = accessDeniedResponse(consent.request);
      clearConsentCookie(response.headers);
      return response;
    }

    const client = await env.OAUTH_PROVIDER.lookupClient(consent.clientId);
    if (!client) return new Response("Unknown OAuth client", { status: 400 });

    const { redirectTo } = await env.OAUTH_PROVIDER.completeAuthorization({
      request: consent.request,
      userId: operatorUserId(operator.subject),
      metadata: { clientName: client.clientName, operatorEmail: operator.email },
      scope: consent.request.scope,
      props: { userId: operatorUserId(operator.subject), operatorEmail: operator.email }
    });

    const response = oauthRedirectResponse(redirectTo);
    clearConsentCookie(response.headers);
    return response;
  }
};

export default new OAuthProvider<Env>({
  apiRoute: "/mcp",
  apiHandler: McpProxyHandler,
  defaultHandler,

  authorizeEndpoint: "/authorize",
  tokenEndpoint: "/oauth/token",
  clientRegistrationEndpoint: "/oauth/register",

  scopesSupported: ["mcp:invoke"],

  // resourceMetadata is fixed at deploy time (the OAuthProvider constructor
  // runs at module load, before any request's env is available). Replace
  // both URLs with this Worker's actual public hostname before deploying --
  // see deployments/cloudflare/docs/WORKER.md.
  resourceMetadata: {
    resource: "https://mcp.majiwari.example/mcp",
    authorization_servers: ["https://mcp.majiwari.example"],
    scopes_supported: ["mcp:invoke"],
    resource_name: "Majiwari MCP gateway"
  }
});
