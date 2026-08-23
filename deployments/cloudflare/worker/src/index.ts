import { verifyAccessAssertion } from "./access";
import { buildProxyTarget, filterHeaders, withServiceToken } from "./proxy";
import { classifyRoute } from "./routes";

export interface Env {
  /** Tunnel-internal origin for the Majiwari gateway. Never exposed to clients. */
  GATEWAY_ORIGIN: string;
  /** Cloudflare Access service-token client ID. Provision with `wrangler secret put`. */
  GATEWAY_ACCESS_CLIENT_ID: string;
  /** Cloudflare Access service-token client secret. Provision with `wrangler secret put`. */
  GATEWAY_ACCESS_CLIENT_SECRET: string;
  /** Cloudflare Access team issuer protecting /mcp, for example https://team.cloudflareaccess.com. */
  MCP_ACCESS_TEAM_DOMAIN: string;
  /** Cloudflare Access application audience tag for the /mcp Managed OAuth boundary. */
  MCP_ACCESS_AUDIENCE: string;
  /** Optional override for the Access certificate endpoint, useful for controlled deployments. */
  ACCESS_CERTS_URL?: string;
}

/**
 * Proxies /mcp to the gateway's internal origin over the Tunnel. Never
 * rewrites MCP semantics (method, headers, streaming body, status) beyond
 * what's required to swap the origin and authenticate the Tunnel -- Cloudflare
 * Access (in front of this Worker) and the Worker-owned Access service token
 * (from this Worker to the origin) are the only things added here.
 */
async function proxyToGateway(request: Request, env: Env): Promise<Response> {
  const target = buildProxyTarget(request.url, env.GATEWAY_ORIGIN);

  const upstream = await fetch(target, {
    method: request.method,
    headers: withServiceToken(request.headers, env.GATEWAY_ACCESS_CLIENT_ID, env.GATEWAY_ACCESS_CLIENT_SECRET),
    body: request.body,
    // @ts-expect-error -- Workers runtime requires this for streamed request bodies.
    duplex: request.body ? "half" : undefined
  });

  return new Response(upstream.body, { status: upstream.status, headers: filterHeaders(upstream.headers) });
}

export default {
  async fetch(request, env, _ctx): Promise<Response> {
    const url = new URL(request.url);
    const route = classifyRoute(url.pathname);

    if (route === "health") {
      return Response.json({ ok: true });
    }

    if (route === "not-found") {
      return new Response("Not found", { status: 404 });
    }

    const identity = await verifyAccessAssertion(request, env);
    if (!identity) {
      return new Response("Cloudflare Access assertion missing or invalid", {
        status: 403,
        headers: { "Cache-Control": "no-store" }
      });
    }

    return proxyToGateway(request, env);
  }
} satisfies ExportedHandler<Env>;
