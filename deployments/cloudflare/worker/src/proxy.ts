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

const AUTHENTICATION_HEADERS = new Set([
  "authorization",
  "proxy-authorization",
  "x-forwarded-authorization",
  "x-original-authorization",
  "x-access-token"
]);

function isAuthenticationHeader(name: string): boolean {
  const normalized = name.toLowerCase();
  return AUTHENTICATION_HEADERS.has(normalized) || normalized.startsWith("cf-access-");
}

function filterCookies(value: string): string | null {
  const cookies = value
    .split(";")
    .map((cookie) => cookie.trim())
    .filter((cookie) => cookie.length > 0)
    .filter((cookie) => {
      const separator = cookie.indexOf("=");
      const name = (separator === -1 ? cookie : cookie.slice(0, separator)).trim();
      return name.toLowerCase() !== "cf_authorization";
    });

  return cookies.length > 0 ? cookies.join("; ") : null;
}

export function filterHeaders(source: Headers): Headers {
  const filtered = new Headers();
  for (const [key, value] of source) {
    const normalized = key.toLowerCase();
    if (normalized === "cookie") {
      const cookies = filterCookies(value);
      if (cookies) filtered.set(key, cookies);
      continue;
    }
    if (!HOP_BY_HOP_HEADERS.has(normalized) && !isAuthenticationHeader(normalized)) {
      filtered.set(key, value);
    }
  }
  return filtered;
}

/** Removes client credentials, then adds only the Worker-owned Access token. */
export function withServiceToken(source: Headers, clientId: string, clientSecret: string): Headers {
  if (!clientId || !clientSecret) {
    throw new Error("Gateway Access service-token secrets are not configured");
  }

  const authenticated = filterHeaders(source);
  authenticated.set("CF-Access-Client-Id", clientId);
  authenticated.set("CF-Access-Client-Secret", clientSecret);
  return authenticated;
}

/** Rewrites an incoming request's path/query onto the gateway origin. Never touches the path/query themselves. */
export function buildProxyTarget(requestUrl: string, gatewayOrigin: string): URL {
  const incoming = new URL(requestUrl);
  const origin = new URL(gatewayOrigin);
  return new URL(incoming.pathname + incoming.search, origin);
}
