import { OAuthProvider, type AuthRequest } from "@cloudflare/workers-oauth-provider";
import { WorkerEntrypoint } from "cloudflare:workers";
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
}

interface AuthProps {
  userId: string;
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

const defaultHandler: ExportedHandler<Env> = {
  async fetch(request, env) {
    const url = new URL(request.url);
    const route = isPublicRoute(url.pathname);

    if (route === "health") {
      return Response.json({ ok: true });
    }

    if (route === "not-found") {
      return new Response("Not found", { status: 404 });
    }

    let oauthRequest: AuthRequest;
    try {
      oauthRequest = await env.OAUTH_PROVIDER.parseAuthRequest(request);
    } catch (error) {
      return new Response(error instanceof Error ? error.message : "invalid authorization request", { status: 400 });
    }

    const client = await env.OAUTH_PROVIDER.lookupClient(oauthRequest.clientId);
    if (!client) {
      return new Response("Unknown OAuth client", { status: 400 });
    }

    // v0 self-host: the deploying operator is the only authorized user.
    // Replace with a real identity/consent step before granting multi-user access.
    const user = { id: "self-hosted-operator" };

    const { redirectTo } = await env.OAUTH_PROVIDER.completeAuthorization({
      request: oauthRequest,
      userId: user.id,
      metadata: { clientName: client.clientName },
      scope: oauthRequest.scope,
      props: { userId: user.id }
    });

    return Response.redirect(redirectTo, 302);
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
