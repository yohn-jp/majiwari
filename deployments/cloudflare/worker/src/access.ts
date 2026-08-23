export interface AccessIdentity {
  subject: string;
  email: string;
}

export interface AccessEnvironment {
  MCP_ACCESS_TEAM_DOMAIN?: string;
  MCP_ACCESS_AUDIENCE?: string;
  ACCESS_CERTS_URL?: string;
}

interface AccessJwtClaims {
  iss?: unknown;
  aud?: unknown;
  sub?: unknown;
  email?: unknown;
  exp?: unknown;
  nbf?: unknown;
}

interface AccessJwk {
  alg?: unknown;
  kid?: unknown;
  kty?: unknown;
  n?: unknown;
  e?: unknown;
  use?: unknown;
}

interface AccessJwksResponse {
  keys?: unknown;
}

function normalizeHttpsUrl(value: string): string | null {
  try {
    const url = new URL(value);
    if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash) return null;
    return url.href.replace(/\/$/, "");
  } catch {
    return null;
  }
}

function decodeBase64Url(value: string): Uint8Array {
  if (!/^[A-Za-z0-9_-]+$/.test(value)) throw new Error("invalid base64url");

  const base64 = value.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat((4 - (value.length % 4)) % 4);
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return bytes;
}

function decodeJson<T>(value: string): T {
  return JSON.parse(new TextDecoder().decode(decodeBase64Url(value))) as T;
}

function audienceMatches(audience: unknown, expected: string): boolean {
  if (typeof audience === "string") return audience === expected;
  return Array.isArray(audience) && audience.some((value) => value === expected);
}

function isAccessJwk(value: unknown): value is AccessJwk {
  if (!value || typeof value !== "object") return false;
  const key = value as AccessJwk;
  return key.kty === "RSA" && typeof key.kid === "string" && typeof key.n === "string" && typeof key.e === "string";
}

async function verifyAccessJwt(token: string, issuer: string, audience: string, certsUrl: string): Promise<AccessJwtClaims | null> {
  const parts = token.split(".");
  if (parts.length !== 3 || parts.some((part) => part.length === 0)) return null;

  try {
    const header = decodeJson<{ alg?: unknown; kid?: unknown }>(parts[0]);
    if (header.alg !== "RS256" || typeof header.kid !== "string") return null;

    const claims = decodeJson<AccessJwtClaims>(parts[1]);
    if (normalizeHttpsUrl(typeof claims.iss === "string" ? claims.iss : "") !== issuer) return null;
    if (!audienceMatches(claims.aud, audience)) return null;
    if (typeof claims.sub !== "string" || claims.sub.length === 0) return null;
    if (typeof claims.email !== "string" || claims.email.length === 0) return null;
    if (typeof claims.exp !== "number" || !Number.isFinite(claims.exp) || claims.exp <= Math.floor(Date.now() / 1000)) {
      return null;
    }
    if (typeof claims.nbf === "number" && claims.nbf > Math.floor(Date.now() / 1000) + 60) return null;

    const response = await fetch(certsUrl, { headers: { accept: "application/json" } });
    if (!response.ok) return null;
    const jwks = (await response.json()) as AccessJwksResponse;
    if (!Array.isArray(jwks.keys)) return null;
    const jwk = jwks.keys.find((key) => isAccessJwk(key) && key.kid === header.kid && (!key.alg || key.alg === "RS256"));
    if (!isAccessJwk(jwk)) return null;

    const cryptoKey = await crypto.subtle.importKey(
      "jwk",
      jwk as JsonWebKey,
      { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
      false,
      ["verify"]
    );
    const valid = await crypto.subtle.verify(
      "RSASSA-PKCS1-v1_5",
      cryptoKey,
      decodeBase64Url(parts[2]),
      new TextEncoder().encode(`${parts[0]}.${parts[1]}`)
    );
    return valid ? claims : null;
  } catch {
    return null;
  }
}

/**
 * Validates the Cloudflare Access assertion presented to the Managed OAuth
 * boundary in front of /mcp. Trusts the Access Policy for who is allowed
 * through; only verifies the assertion is genuine, current, and scoped to
 * this application. Missing or invalid configuration, assertions, and
 * identities all fail closed.
 */
export async function verifyAccessAssertion(request: Request, env: AccessEnvironment): Promise<AccessIdentity | null> {
  const teamDomain = env.MCP_ACCESS_TEAM_DOMAIN ? normalizeHttpsUrl(env.MCP_ACCESS_TEAM_DOMAIN) : null;
  const audience = env.MCP_ACCESS_AUDIENCE?.trim();
  const token = request.headers.get("Cf-Access-Jwt-Assertion");
  if (!teamDomain || !audience || !token) return null;

  const certsUrl = env.ACCESS_CERTS_URL ? normalizeHttpsUrl(env.ACCESS_CERTS_URL) : `${teamDomain}/cdn-cgi/access/certs`;
  if (!certsUrl) return null;

  const claims = await verifyAccessJwt(token, teamDomain, audience, certsUrl);
  const email = claims?.email;
  if (!claims || typeof email !== "string" || email.trim().length === 0) return null;

  return { subject: claims.sub as string, email: email.trim().toLowerCase() };
}
