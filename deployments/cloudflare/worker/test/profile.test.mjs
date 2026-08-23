import { deepStrictEqual, doesNotMatch, match, strictEqual, throws } from "node:assert";
import { describe, it } from "node:test";
import {
  GATEWAY_VPC_BINDING,
  ProfileValidationError,
  buildWranglerConfig,
  safeProfileSummary,
  validateDeploymentProfile
} from "../scripts/profile.mjs";

const validProfile = {
  accountId: "0123456789abcdef0123456789abcdef",
  publicMcpUrl: "https://mcp.test/mcp",
  gatewayVpcServiceId: "vpc-service-abc123",
  mcpAccess: {
    teamDomain: "https://majiwari.cloudflareaccess.com",
    audience: "mcp-access-audience"
  }
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
      gatewayVpcServiceId: "REPLACE_WITH_GATEWAY_VPC_SERVICE_ID"
    }, /placeholder/);
  });

  it("requires a gatewayVpcServiceId", () => {
    assertInvalid({ gatewayVpcServiceId: "" }, /gatewayVpcServiceId is required/);
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
    strictEqual(config.vars.MCP_ACCESS_TEAM_DOMAIN, validProfile.mcpAccess.teamDomain);
    strictEqual(config.vars.MCP_ACCESS_AUDIENCE, validProfile.mcpAccess.audience);
    strictEqual(config.vars.EXISTING, "kept");
    deepStrictEqual(config.vpc_services, [{ binding: GATEWAY_VPC_BINDING, service_id: validProfile.gatewayVpcServiceId }]);
    deepStrictEqual(config.routes, [{ pattern: "mcp.test", custom_domain: true }]);
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
