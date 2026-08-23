import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const WORKER_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export const DEFAULT_PROFILE_PATH = path.resolve(WORKER_DIR, "..", "deployment-profile.local.json");
export const PUBLIC_MCP_DEFINE = "__MAJIWARI_PUBLIC_MCP_URL__";
export const ORIGIN_ACCESS_ID_BINDING = "GATEWAY_ACCESS_CLIENT_ID";
export const ORIGIN_ACCESS_SECRET_BINDING = "GATEWAY_ACCESS_CLIENT_SECRET";

export function resolveProfilePath(value) {
  if (path.isAbsolute(value)) return value;
  const fromCurrentDirectory = path.resolve(process.cwd(), value);
  if (existsSync(fromCurrentDirectory)) return fromCurrentDirectory;
  return path.resolve(WORKER_DIR, "../../..", value);
}

const PROFILE_FIELDS = new Set([
  "accountId",
  "publicMcpUrl",
  "gatewayOrigin",
  "oauthKvNamespaceId",
  "operatorAccess",
  "secretBindings"
]);
const OPERATOR_ACCESS_FIELDS = new Set(["teamDomain", "audience", "operatorEmail"]);
const PLACEHOLDER_PATTERN = /REPLACE_WITH|CHANGE_ME|YOUR(?:[-_ ]|$)|<[^>]+>|example\.(?:com|net|org|invalid)/i;
const SECRET_KEY_PATTERN = /(?:secret|password|token|private.?key|credential|api.?key)/i;
const BINDING_PATTERN = /^[A-Z][A-Z0-9_]*$/;
const CLOUDFLARE_ID_PATTERN = /^[0-9a-f]{32}$/i;

export class ProfileValidationError extends Error {
  constructor(errors) {
    super(`deployment profile invalid:\n${errors.map((error) => `- ${error}`).join("\n")}`);
    this.name = "ProfileValidationError";
    this.errors = errors;
  }
}

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isPlaceholder(value) {
  return PLACEHOLDER_PATTERN.test(value) || /^0+$/.test(value);
}

function addUnknownFieldErrors(record, allowed, prefix, errors) {
  for (const key of Object.keys(record)) {
    if (!allowed.has(key)) errors.push(`${prefix}.${key} is not a supported profile field`);
  }
}

function requiredString(record, field, errors) {
  const value = record[field];
  if (typeof value !== "string" || value.trim() === "") {
    errors.push(`${field} is required`);
    return undefined;
  }
  return value;
}

function parseMcpUrl(value, field, errors) {
  if (typeof value !== "string" || value.trim() === "") {
    errors.push(`${field} is required`);
    return undefined;
  }
  if (isPlaceholder(value)) errors.push(`${field} contains a placeholder`);

  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    errors.push(`${field} must be a valid URL`);
    return undefined;
  }

  if (parsed.protocol !== "https:") errors.push(`${field} must use https`);
  if (parsed.username || parsed.password || parsed.search || parsed.hash) {
    errors.push(`${field} must not contain credentials, query, or fragment`);
  }
  if (parsed.pathname !== "/mcp") errors.push(`${field} must use the exact /mcp path`);
  if (parsed.toString() !== value) errors.push(`${field} must be a canonical URL`);
  return parsed;
}

function validateCloudflareId(value, field, errors) {
  if (typeof value !== "string" || value.trim() === "") {
    errors.push(`${field} is required`);
    return;
  }
  if (isPlaceholder(value)) errors.push(`${field} contains a placeholder`);
  if (!CLOUDFLARE_ID_PATTERN.test(value)) errors.push(`${field} must be a 32-character hexadecimal ID`);
}

function validateTeamDomain(value, field, errors) {
  if (typeof value !== "string" || value.trim() === "") {
    errors.push(`${field} is required`);
    return;
  }
  if (isPlaceholder(value)) errors.push(`${field} contains a placeholder`);

  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    errors.push(`${field} must be a valid URL`);
    return;
  }
  if (parsed.protocol !== "https:") errors.push(`${field} must use https`);
  if (parsed.pathname !== "/" || parsed.search || parsed.hash) {
    errors.push(`${field} must not contain a path, query, or fragment`);
  }
}

function validateOperatorEmail(value, field, errors) {
  if (typeof value !== "string" || value.trim() === "") {
    errors.push(`${field} is required`);
    return;
  }
  if (isPlaceholder(value)) errors.push(`${field} contains a placeholder`);
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value)) errors.push(`${field} must be a valid email address`);
}

function validateOperatorAccess(operatorAccess, errors) {
  if (!isRecord(operatorAccess)) {
    errors.push("operatorAccess is required");
    return;
  }
  addUnknownFieldErrors(operatorAccess, OPERATOR_ACCESS_FIELDS, "operatorAccess", errors);
  validateTeamDomain(operatorAccess.teamDomain, "operatorAccess.teamDomain", errors);
  const audience = requiredString({ "operatorAccess.audience": operatorAccess.audience }, "operatorAccess.audience", errors);
  if (audience && isPlaceholder(audience)) errors.push("operatorAccess.audience contains a placeholder");
  validateOperatorEmail(operatorAccess.operatorEmail, "operatorAccess.operatorEmail", errors);
}

function validateSecretBindings(value, errors) {
  if (!Array.isArray(value) || value.length === 0) {
    errors.push("secretBindings must list at least one Wrangler secret binding");
    return;
  }
  const bindings = new Set();
  for (const binding of value) {
    if (typeof binding !== "string" || !BINDING_PATTERN.test(binding)) {
      errors.push("secretBindings must contain uppercase Wrangler binding names only");
      continue;
    }
    if (bindings.has(binding)) errors.push(`secretBindings contains duplicate binding ${binding}`);
    bindings.add(binding);
  }
  if (!bindings.has(ORIGIN_ACCESS_ID_BINDING)) {
    errors.push(`secretBindings must include ${ORIGIN_ACCESS_ID_BINDING}`);
  }
  if (!bindings.has(ORIGIN_ACCESS_SECRET_BINDING)) {
    errors.push(`secretBindings must include ${ORIGIN_ACCESS_SECRET_BINDING}`);
  }
}

function validateNoSecretValues(value, field = "profile") {
  if (!isRecord(value)) return [];
  const errors = [];
  for (const [key, child] of Object.entries(value)) {
    const childField = `${field}.${key}`;
    if (SECRET_KEY_PATTERN.test(key) && key !== "secretBindings") {
      errors.push(`${childField} must be a binding name; secret values belong in Wrangler secret bindings`);
      continue;
    }
    if (isRecord(child)) errors.push(...validateNoSecretValues(child, childField));
    if (Array.isArray(child)) {
      for (const item of child) {
        if (isRecord(item)) errors.push(...validateNoSecretValues(item, childField));
      }
    }
  }
  return errors;
}

export function validateDeploymentProfile(profile) {
  const errors = [];
  if (!isRecord(profile)) throw new ProfileValidationError(["profile root must be a JSON object"]);

  addUnknownFieldErrors(profile, PROFILE_FIELDS, "profile", errors);
  errors.push(...validateNoSecretValues(profile));

  const accountId = requiredString(profile, "accountId", errors);
  if (accountId) validateCloudflareId(accountId, "accountId", errors);

  const publicMcpUrl = parseMcpUrl(profile.publicMcpUrl, "publicMcpUrl", errors);
  const gatewayOrigin = parseMcpUrl(profile.gatewayOrigin, "gatewayOrigin", errors);
  if (publicMcpUrl && gatewayOrigin && publicMcpUrl.origin === gatewayOrigin.origin) {
    errors.push("public-resource/origin mismatch: publicMcpUrl and gatewayOrigin must use different origins");
  }

  const oauthKvNamespaceId = requiredString(profile, "oauthKvNamespaceId", errors);
  if (oauthKvNamespaceId) validateCloudflareId(oauthKvNamespaceId, "oauthKvNamespaceId", errors);

  validateOperatorAccess(profile.operatorAccess, errors);
  validateSecretBindings(profile.secretBindings, errors);

  if (errors.length > 0) throw new ProfileValidationError(errors);
  return profile;
}

export async function readDeploymentProfile(profilePath = DEFAULT_PROFILE_PATH) {
  let raw;
  try {
    raw = await readFile(profilePath, "utf8");
  } catch {
    throw new Error(`deployment profile not found: ${profilePath}`);
  }

  let profile;
  try {
    profile = JSON.parse(raw);
  } catch {
    throw new Error(`deployment profile is not valid JSON: ${profilePath}`);
  }
  return validateDeploymentProfile(profile);
}

export function buildWranglerConfig(baseConfig, profile) {
  const config = structuredClone(baseConfig);
  config.account_id = profile.accountId;
  config.kv_namespaces = [{ binding: "OAUTH_KV", id: profile.oauthKvNamespaceId }];
  config.vars = {
    ...(config.vars ?? {}),
    GATEWAY_ORIGIN: profile.gatewayOrigin,
    ACCESS_TEAM_DOMAIN: profile.operatorAccess.teamDomain,
    ACCESS_AUDIENCE: profile.operatorAccess.audience,
    OPERATOR_EMAIL: profile.operatorAccess.operatorEmail
  };
  config.define = {
    ...(config.define ?? {}),
    [PUBLIC_MCP_DEFINE]: JSON.stringify(profile.publicMcpUrl)
  };
  config.secrets = { required: [...profile.secretBindings] };
  return config;
}

export function safeProfileSummary(profile) {
  return [
    `publicMcpUrl: ${profile.publicMcpUrl}`,
    `gatewayOrigin: ${profile.gatewayOrigin}`,
    "accountId: configured",
    "oauthKvNamespaceId: configured",
    "operatorAccess.teamDomain: configured",
    "operatorAccess.audience: configured",
    "operatorAccess.operatorEmail: configured",
    `secretBindings: ${profile.secretBindings.join(", ")}`
  ].join("\n");
}
