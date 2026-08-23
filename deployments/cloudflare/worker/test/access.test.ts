import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { authenticateOperator } from "../src/access";

const environment = {
  ACCESS_TEAM_DOMAIN: "https://team.cloudflareaccess.com",
  ACCESS_AUDIENCE: "access-audience",
  OPERATOR_EMAIL: "operator@example.com"
};

function encodeJson(value: unknown): string {
  const bytes = new TextEncoder().encode(JSON.stringify(value));
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

async function signedAccessToken(privateKey: CryptoKey, claims: Record<string, unknown>): Promise<string> {
  const header = encodeJson({ alg: "RS256", kid: "access-key", typ: "JWT" });
  const payload = encodeJson({
    iss: environment.ACCESS_TEAM_DOMAIN,
    aud: [environment.ACCESS_AUDIENCE],
    sub: "operator-subject",
    email: "operator@example.com",
    exp: Math.floor(Date.now() / 1000) + 300,
    ...claims
  });
  const signingInput = `${header}.${payload}`;
  const signature = await crypto.subtle.sign(
    "RSASSA-PKCS1-v1_5",
    privateKey,
    new TextEncoder().encode(signingInput)
  );
  let binary = "";
  for (const byte of new Uint8Array(signature)) binary += String.fromCharCode(byte);
  const encodedSignature = btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  return `${signingInput}.${encodedSignature}`;
}

describe("authenticateOperator", () => {
  let privateKey: CryptoKey;
  let publicJwk: JsonWebKey;

  beforeAll(async () => {
    const pair = await crypto.subtle.generateKey(
      { name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" },
      true,
      ["sign", "verify"]
    );
    if (!("privateKey" in pair)) throw new Error("expected RSA key pair");
    privateKey = pair.privateKey;
    publicJwk = (await crypto.subtle.exportKey("jwk", pair.publicKey)) as JsonWebKey;
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("accepts a valid Cloudflare Access assertion for the configured operator", async () => {
    const token = await signedAccessToken(privateKey, {});
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({ keys: [{ ...publicJwk, kid: "access-key", alg: "RS256" }] })));

    const identity = await authenticateOperator(
      new Request("https://mcp.example/authorize", { headers: { "Cf-Access-Jwt-Assertion": token } }),
      environment
    );

    expect(identity).toEqual({ subject: "operator-subject", email: "operator@example.com" });
  });

  it("rejects missing, expired, wrong-audience, wrong-email, and tampered assertions", async () => {
    const fetchCertificates = vi.fn(async () => Response.json({ keys: [{ ...publicJwk, kid: "access-key", alg: "RS256" }] }));
    vi.stubGlobal("fetch", fetchCertificates);

    expect(await authenticateOperator(new Request("https://mcp.example/authorize"), environment)).toBeNull();

    const expired = await signedAccessToken(privateKey, { exp: Math.floor(Date.now() / 1000) - 1 });
    expect(
      await authenticateOperator(
        new Request("https://mcp.example/authorize", { headers: { "Cf-Access-Jwt-Assertion": expired } }),
        environment
      )
    ).toBeNull();

    const wrongAudience = await signedAccessToken(privateKey, { aud: "another-audience" });
    expect(
      await authenticateOperator(
        new Request("https://mcp.example/authorize", { headers: { "Cf-Access-Jwt-Assertion": wrongAudience } }),
        environment
      )
    ).toBeNull();

    const wrongEmail = await signedAccessToken(privateKey, { email: "other@example.com" });
    expect(
      await authenticateOperator(
        new Request("https://mcp.example/authorize", { headers: { "Cf-Access-Jwt-Assertion": wrongEmail } }),
        environment
      )
    ).toBeNull();

    const valid = await signedAccessToken(privateKey, {});
    const attacker = await signedAccessToken(privateKey, { sub: "attacker-subject" });
    const tampered = `${attacker.slice(0, attacker.lastIndexOf("."))}.${valid.slice(valid.lastIndexOf(".") + 1)}`;
    expect(
      await authenticateOperator(
        new Request("https://mcp.example/authorize", { headers: { "Cf-Access-Jwt-Assertion": tampered } }),
        environment
      )
    ).toBeNull();
    expect(fetchCertificates).toHaveBeenCalled();
  });
});
