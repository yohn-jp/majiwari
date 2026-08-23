import { deepStrictEqual, doesNotMatch, match, strictEqual, throws } from "node:assert";
import { describe, it } from "node:test";
import {
  ORIGIN_ACCESS_ID_BINDING,
  ORIGIN_ACCESS_SECRET_BINDING,
  PUBLIC_MCP_DEFINE,
  ProfileValidationError,
  buildWranglerConfig,
  safeProfileSummary,
  validateDeploymentProfile
} from "../scripts/profile.mjs";

const validProfile = {
  accountId: "0123456789abcdef0123456789abcdef",
  publicMcpUrl: "https://mcp.test/mcp",
  gatewayOrigin: "https://gateway.internal.test/mcp",
  oauthKvNamespaceId: "abcdef0123456789abcdef0123456789",
  operatorAccess: {
    teamDomain: "https://majiwari.cloudflareaccess.com",
    audience: "operator-access-audience",
    operatorEmail: "operator@example.test"
  },
  secretBindings: [ORIGIN_ACCESS_ID_BINDING, ORIGIN_ACCESS_SECRET_BINDING]
};

const baseWranglerConfig = {
  vars: { EXISTING: "kept" },
  durable_objects: {
    bindings: [{ name: "CONSENT_STATE", class_name: "ConsentStateDurableObject" }]
  },
  migrations: [{ tag: "v1-consent-state", new_sqlite_classes: ["ConsentStateDurableObject"] }]
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
      gatewayOrigin: "http://gateway.example.invalid/not-mcp",
      oauthKvNamespaceId: "REPLACE_WITH_KV_ID"
    }, /placeholder|must use https|exact \/mcp path|32-character hexadecimal/);
  });

  it("rejects a public resource and Tunnel origin with the same origin", () => {
    assertInvalid({ gatewayOrigin: validProfile.publicMcpUrl }, /public-resource\/origin mismatch/);
  });

  it("requires both origin-access secret bindings without accepting secret values", () => {
    assertInvalid({ secretBindings: [] }, /secretBindings must list/);
    assertInvalid({ secretBindings: [ORIGIN_ACCESS_ID_BINDING] }, new RegExp(`secretBindings must include ${ORIGIN_ACCESS_SECRET_BINDING}`));
    assertInvalid({ secretBindings: [ORIGIN_ACCESS_SECRET_BINDING] }, new RegExp(`secretBindings must include ${ORIGIN_ACCESS_ID_BINDING}`));
    assertInvalid(
      { operatorAccess: { ...validProfile.operatorAccess, clientSecret: "do-not-print" } },
      /not a supported profile field/
    );
  });

  it("requires the KV binding resource ID", () => {
    assertInvalid({ oauthKvNamespaceId: undefined }, /oauthKvNamespaceId is required/);
  });

  it("keeps the operator-access boundary separate from origin-access secret bindings", () => {
    assertInvalid({ operatorAccess: undefined }, /operatorAccess is required/);
    assertInvalid({ operatorAccess: { ...validProfile.operatorAccess, teamDomain: "not-a-url" } }, /operatorAccess\.teamDomain must be a valid URL/);
    assertInvalid({ operatorAccess: { ...validProfile.operatorAccess, operatorEmail: "not-an-email" } }, /operatorAccess\.operatorEmail must be a valid email address/);
  });
});

describe("generated Wrangler configuration", () => {
  it("maps profile values without putting secret values into config", () => {
    const config = buildWranglerConfig(baseWranglerConfig, validProfile);
    strictEqual(config.account_id, validProfile.accountId);
    deepStrictEqual(config.kv_namespaces, [{ binding: "OAUTH_KV", id: validProfile.oauthKvNamespaceId }]);
    strictEqual(config.vars.GATEWAY_ORIGIN, validProfile.gatewayOrigin);
    strictEqual(config.vars.ACCESS_TEAM_DOMAIN, validProfile.operatorAccess.teamDomain);
    strictEqual(config.vars.ACCESS_AUDIENCE, validProfile.operatorAccess.audience);
    strictEqual(config.vars.OPERATOR_EMAIL, validProfile.operatorAccess.operatorEmail);
    strictEqual(config.define[PUBLIC_MCP_DEFINE], JSON.stringify(validProfile.publicMcpUrl));
    deepStrictEqual(config.secrets, { required: [ORIGIN_ACCESS_ID_BINDING, ORIGIN_ACCESS_SECRET_BINDING] });
    doesNotMatch(JSON.stringify(config), /do-not-print|secret-value/i);
  });

  it("preserves the CONSENT_STATE durable object binding and its migration from the base config", () => {
    const config = buildWranglerConfig(baseWranglerConfig, validProfile);
    deepStrictEqual(config.durable_objects, baseWranglerConfig.durable_objects);
    deepStrictEqual(config.migrations, baseWranglerConfig.migrations);
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
