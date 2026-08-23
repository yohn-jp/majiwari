export const HOP_BY_HOP_HEADERS = new Set([
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
  "host"
]);

export function filterHeaders(source: Headers): Headers {
  const filtered = new Headers();
  for (const [key, value] of source) {
    if (!HOP_BY_HOP_HEADERS.has(key.toLowerCase())) filtered.set(key, value);
  }
  return filtered;
}

/** Rewrites an incoming request's path/query onto the gateway origin. Never touches the path/query themselves. */
export function buildProxyTarget(requestUrl: string, gatewayOrigin: string): URL {
  const incoming = new URL(requestUrl);
  const origin = new URL(gatewayOrigin);
  return new URL(incoming.pathname + incoming.search, origin);
}
