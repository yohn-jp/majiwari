import { z } from "zod";
import { targetProviderContractSchema } from "./target-provider.js";

export const MANIFEST_SCHEMA_VERSION = "1";

const ID_PATTERN = /^[a-z][a-z0-9-]{1,63}$/;
const VERSION_PATTERN = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;

export class AdapterManifestError extends Error {
  constructor(message) {
    super(message);
    this.name = "AdapterManifestError";
  }
}

function isFunction(value) {
  return typeof value === "function";
}

const stdioTransportSchema = z
  .object({
    kind: z.literal("stdio"),
    start: z.custom(isFunction, { message: "stdio transport requires a start() function" }),
    stop: z.custom(isFunction, { message: "stop must be a function" }).optional()
  })
  .strict();

const endpointTransportSchema = z
  .object({
    kind: z.literal("endpoint"),
    url: z.string().min(1, "endpoint transport requires a non-empty url"),
    connect: z.custom(isFunction, { message: "connect must be a function" }).optional(),
    disconnect: z.custom(isFunction, { message: "disconnect must be a function" }).optional()
  })
  .strict();

const transportSchema = z.discriminatedUnion("kind", [stdioTransportSchema, endpointTransportSchema]);

const manifestSchema = z
  .object({
    schemaVersion: z.literal(MANIFEST_SCHEMA_VERSION, {
      message: `schemaVersion must be "${MANIFEST_SCHEMA_VERSION}"`
    }),
    id: z.string().regex(ID_PATTERN, "id must be lowercase alphanumeric with hyphens, 2-64 chars, starting with a letter"),
    version: z.string().regex(VERSION_PATTERN, "version must be a semantic version, e.g. 1.0.0"),
    displayName: z.string().min(1).optional(),
    transport: transportSchema,
    health: z.custom(isFunction, { message: "health must be a function" }).optional(),
    listTools: z.custom(isFunction, { message: "listTools must be a function" }).optional(),
    capabilities: z.array(z.string().min(1)).optional(),
    // Optional target-provider capability (#26): opaque-target list/get/
    // resolve/invalidate hooks. Absent by default -- adapters that never
    // set this field are validated and behave exactly as before.
    targetProvider: targetProviderContractSchema.optional()
  })
  .strict();

function formatIssues(error) {
  return error.issues
    .map((issue) => {
      const path = issue.path.length ? issue.path.join(".") : "(manifest)";
      return `${path}: ${issue.message}`;
    })
    .join("; ");
}

/**
 * Validate an adapter manifest against the versioned schema and return a
 * normalized copy. Throws AdapterManifestError with a deterministic,
 * field-addressed message on any invalid input -- unknown fields included.
 */
export function validateManifest(manifest) {
  const parsed = manifestSchema.safeParse(manifest);
  if (!parsed.success) {
    throw new AdapterManifestError(`invalid adapter manifest: ${formatIssues(parsed.error)}`);
  }
  return parsed.data;
}
