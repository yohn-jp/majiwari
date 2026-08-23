import { deepStrictEqual, doesNotMatch, match, strictEqual, throws } from "node:assert";
import { describe, it } from "node:test";
import {
  ORIGIN_ACCESS_ID_BINDING,
  ORIGIN_ACCESS_SECRET_BINDING,
  ProfileValidationError,
  buildWranglerConfig,
  safeProfileSummary,
  validateDeploymentProfile
} from "../scripts/profile.mjs";

const validProfile = {
  accountId: "0123456789abcdef0123456789abcdef",
  publicMcpUrl: "https://mcp.test/mcp",
  gatewayOrigin: "https://gateway.internal.test/mcp",
  mcpAccess: {
    teamDomain: "https://majiwari.cloudflareaccess.com",
    audience: "mcp-access-audience"
  },
  secretBindings: [ORIGIN_ACCESS_ID_BINDING, ORIGIN_ACCESS_SECRET_BINDING]
};

const baseWranglerConfig = {
  vars: { EXISTING: "kept" }
};

function copyProfile(overrides = {}) {
  return structuredClone({ ...validProfile, ...overrides });
}

describe("deployment profile validation", () => {
  it("accepts a complete profile", () => {
    deepStrictEqual(validateDeploymentProfile(copyProfile()), validProfile);
  });

  it("rejects placeholders and malformed URLs", () => {
    assertInvalid({
      publicMcpUrl: "REPLACE_WITH_PUBLIC_URL",
      gatewayOrigin: "http://gateway.example.invalid/not-mcp"
    }, /placeholder|must use https|exact \/mcp path/);
  });

  it("rejects a public resource and Tunnel origin with the same origin", () => {
    assertInvalid({ gatewayOrigin: validProfile.publicMcpUrl }, /public-resource\/origin mismatch/);
  });

  it("requires both origin-access secret bindings without accepting secret values", () => {
    assertInvalid({ secretBindings: [] }, /secretBindings must list/);
    assertInvalid({ secretBindings: [ORIGIN_ACCESS_ID_BINDING] }, new RegExp(`secretBindings must include ${ORIGIN_ACCESS_SECRET_BINDING}`));
    assertInvalid({ secretBindings: [ORIGIN_ACCESS_SECRET_BINDING] }, new RegExp(`secretBindings must include ${ORIGIN_ACCESS_ID_BINDING}`));
    assertInvalid(
      { mcpAccess: { ...validProfile.mcpAccess, clientSecret: "do-not-print" } },
      /not a supported profile field/
    );
  });

  it("keeps the /mcp Access boundary separate from origin-access secret bindings", () => {
    assertInvalid({ mcpAccess: undefined }, /mcpAccess is required/);
    assertInvalid({ mcpAccess: { ...validProfile.mcpAccess, teamDomain: "not-a-url" } }, /mcpAccess\.teamDomain must be a valid URL/);
    assertInvalid({ mcpAccess: { ...validProfile.mcpAccess, audience: "" } }, /mcpAccess\.audience is required/);
  });
});

describe("generated Wrangler configuration", () => {
  it("maps profile values without putting secret values into config", () => {
    const config = buildWranglerConfig(baseWranglerConfig, validProfile);
    strictEqual(config.account_id, validProfile.accountId);
    strictEqual(config.vars.GATEWAY_ORIGIN, validProfile.gatewayOrigin);
    strictEqual(config.vars.MCP_ACCESS_TEAM_DOMAIN, validProfile.mcpAccess.teamDomain);
    strictEqual(config.vars.MCP_ACCESS_AUDIENCE, validProfile.mcpAccess.audience);
    strictEqual(config.vars.EXISTING, "kept");
    deepStrictEqual(config.secrets, { required: [ORIGIN_ACCESS_ID_BINDING, ORIGIN_ACCESS_SECRET_BINDING] });
    doesNotMatch(JSON.stringify(config), /do-not-print|secret-value/i);
  });
});

it("safe diagnostics do not include secret-looking values", () => {
  const summary = safeProfileSummary(validProfile);
  match(summary, /publicMcpUrl: https:\/\/mcp\.test\/mcp/);
  doesNotMatch(summary, /client-secret|secret-value|access-token/i);
});

function assertInvalid(overrides, expected) {
  throws(() => validateDeploymentProfile(copyProfile(overrides)), (error) => {
    if (!(error instanceof ProfileValidationError)) return false;
    doesNotMatch(error.message, /do-not-print|secret-value|access-token/i);
    return expected.test(error.message);
  });
}
