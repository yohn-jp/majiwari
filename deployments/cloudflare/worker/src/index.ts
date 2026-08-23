import { verifyAccessAssertion } from "./access";
import { buildProxyTarget, filterHeaders } from "./proxy";
import { classifyRoute } from "./routes";

export interface Env {
  /** Workers VPC Service binding reaching the gateway over the Tunnel, bypassing the public zone's WAF entirely. */
  GATEWAY_VPC: Fetcher;
  /** Cloudflare Access team issuer protecting /mcp, for example https://team.cloudflareaccess.com. */
  MCP_ACCESS_TEAM_DOMAIN: string;
  /** Cloudflare Access application audience tag for the /mcp Managed OAuth boundary. */
  MCP_ACCESS_AUDIENCE: string;
  /** Optional override for the Access certificate endpoint, useful for controlled deployments. */
  ACCESS_CERTS_URL?: string;
}

/**
 * Proxies /mcp to the gateway over the Workers VPC Service binding. Never
 * rewrites MCP semantics (method, headers, streaming body, status) beyond
 * what's required to swap the target address -- Cloudflare Access (in front
 * of this Worker) is the only auth layer; the VPC Service binding itself
 * proves the request came from this Worker, so no origin-side credential is
 * added here.
 */
async function proxyToGateway(request: Request, env: Env): Promise<Response> {
  const target = buildProxyTarget(request.url);

  const upstream = await env.GATEWAY_VPC.fetch(target, {
    method: request.method,
    headers: filterHeaders(request.headers),
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
