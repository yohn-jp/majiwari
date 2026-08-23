import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const WORKER_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export const DEFAULT_PROFILE_PATH = path.resolve(WORKER_DIR, "..", "deployment-profile.local.json");
export const GATEWAY_VPC_BINDING = "GATEWAY_VPC";

export function resolveProfilePath(value) {
  if (path.isAbsolute(value)) return value;
  const fromCurrentDirectory = path.resolve(process.cwd(), value);
  if (existsSync(fromCurrentDirectory)) return fromCurrentDirectory;
  return path.resolve(WORKER_DIR, "../../..", value);
}

const PROFILE_FIELDS = new Set(["accountId", "publicMcpUrl", "gatewayVpcServiceId", "mcpAccess"]);
const MCP_ACCESS_FIELDS = new Set(["teamDomain", "audience"]);
const PLACEHOLDER_PATTERN = /REPLACE_WITH|CHANGE_ME|YOUR(?:[-_ ]|$)|<[^>]+>|example\.(?:com|net|org|invalid)/i;
const SECRET_KEY_PATTERN = /(?:secret|password|token|private.?key|credential|api.?key)/i;
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

function validateMcpAccess(mcpAccess, errors) {
  if (!isRecord(mcpAccess)) {
    errors.push("mcpAccess is required");
    return;
  }
  addUnknownFieldErrors(mcpAccess, MCP_ACCESS_FIELDS, "mcpAccess", errors);
  validateTeamDomain(mcpAccess.teamDomain, "mcpAccess.teamDomain", errors);
  const audience = requiredString({ "mcpAccess.audience": mcpAccess.audience }, "mcpAccess.audience", errors);
  if (audience && isPlaceholder(audience)) errors.push("mcpAccess.audience contains a placeholder");
}

function validateGatewayVpcServiceId(value, errors) {
  if (typeof value !== "string" || value.trim() === "") {
    errors.push("gatewayVpcServiceId is required");
    return;
  }
  if (isPlaceholder(value)) errors.push("gatewayVpcServiceId contains a placeholder");
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

  parseMcpUrl(profile.publicMcpUrl, "publicMcpUrl", errors);
  validateGatewayVpcServiceId(profile.gatewayVpcServiceId, errors);

  validateMcpAccess(profile.mcpAccess, errors);

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
  config.vars = {
    ...(config.vars ?? {}),
    MCP_ACCESS_TEAM_DOMAIN: profile.mcpAccess.teamDomain,
    MCP_ACCESS_AUDIENCE: profile.mcpAccess.audience
  };
  config.vpc_services = [{ binding: GATEWAY_VPC_BINDING, service_id: profile.gatewayVpcServiceId }];
  config.routes = [{ pattern: new URL(profile.publicMcpUrl).hostname, custom_domain: true }];
  return config;
}

export function safeProfileSummary(profile) {
  return [
    `publicMcpUrl: ${profile.publicMcpUrl}`,
    "gatewayVpcServiceId: configured",
    "accountId: configured",
    "mcpAccess.teamDomain: configured",
    "mcpAccess.audience: configured"
  ].join("\n");
}
