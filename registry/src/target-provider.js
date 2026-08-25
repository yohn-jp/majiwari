import { z } from "zod";

export const TARGET_PROVIDER_SCHEMA_VERSION = "1";

const TARGET_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

export class TargetProviderError extends Error {
  constructor(message) {
    super(message);
    this.name = "TargetProviderError";
  }
}

export class InvalidTargetIdError extends TargetProviderError {
  constructor(targetId) {
    super(`target id ${JSON.stringify(targetId)} is not a valid opaque target identifier`);
    this.name = "InvalidTargetIdError";
  }
}

export class TargetNotFoundError extends TargetProviderError {
  constructor(targetId) {
    super(`no target registered with id "${targetId}"`);
    this.name = "TargetNotFoundError";
  }
}

export class TargetUnavailableError extends TargetProviderError {
  constructor(targetId) {
    super(`target "${targetId}" is unavailable`);
    this.name = "TargetUnavailableError";
  }
}

function isFunction(value) {
  return typeof value === "function";
}

// A JSON-safe value: string, finite number, boolean, null, or an array/plain
// object built entirely out of these. Explicitly excludes anything that
// cannot round-trip through JSON.stringify/parse -- a function, BigInt,
// Symbol, Map/Set, Date, class instance, undefined, or a number that is
// NaN/Infinity -- so a public target's metadata can never carry a value a
// remote client could not receive as-is.
const jsonValueSchema = z.lazy(() =>
  z.union([z.string(), z.number().finite(), z.boolean(), z.null(), z.array(jsonValueSchema), z.record(z.string(), jsonValueSchema)])
);

// Opaque identifier only: no path separators, `.`/`..` segments, or null
// bytes, so a client-supplied value can never be mistaken for (or smuggled
// through as) a filesystem path. Real identity/lookup stays owned by the
// adapter's own provider implementation.
export const targetIdSchema = z
  .string()
  .regex(TARGET_ID_PATTERN, "target id must be an opaque identifier (letters, digits, '.', '_', '-'; no path separators)");

// Safe-to-expose-to-remote-clients descriptor. Deliberately has no field for
// an adapter-internal descriptor (e.g. a filesystem path) -- `.strict()`
// means a provider that accidentally returns one here fails validation
// instead of leaking it. `metadata` values are restricted to JSON-safe
// types by contract (see jsonValueSchema above), not by convention.
export const publicTargetSchema = z
  .object({
    id: targetIdSchema,
    kind: z.string().min(1).optional(),
    displayName: z.string().min(1).optional(),
    metadata: z.record(z.string(), jsonValueSchema).optional()
  })
  .strict();

// Internal descriptor, only ever produced by resolve() and only ever meant
// to cross the adapter/runtime boundary -- never returned by list()/get().
// `descriptor` is intentionally opaque to the registry: what it contains is
// entirely adapter-defined.
export const resolvedTargetSchema = z
  .object({
    id: targetIdSchema,
    kind: z.string().min(1).optional(),
    displayName: z.string().min(1).optional(),
    metadata: z.record(z.string(), jsonValueSchema).optional(),
    // Adapter-internal only, never projected to a remote client: unlike
    // every other field here, this one is deliberately exempt from the
    // JSON-safe contract above -- it stays opaque to the registry.
    descriptor: z.unknown()
  })
  .strict();

export const targetProviderContractSchema = z
  .object({
    schemaVersion: z.literal(TARGET_PROVIDER_SCHEMA_VERSION, {
      message: `targetProvider.schemaVersion must be "${TARGET_PROVIDER_SCHEMA_VERSION}"`
    }),
    list: z.custom(isFunction, { message: "targetProvider.list must be a function" }),
    get: z.custom(isFunction, { message: "targetProvider.get must be a function" }),
    resolve: z.custom(isFunction, { message: "targetProvider.resolve must be a function" }),
    invalidate: z.custom(isFunction, { message: "targetProvider.invalidate must be a function" })
  })
  .strict();

function formatIssues(error) {
  return error.issues
    .map((issue) => {
      const path = issue.path.length ? issue.path.join(".") : "(targetProvider)";
      return `${path}: ${issue.message}`;
    })
    .join("; ");
}

/**
 * Validate the shape of a target-provider contract (four hook functions on
 * a versioned envelope). Mirrors validateManifest: deterministic,
 * field-addressed errors; unknown fields rejected.
 */
export function validateTargetProviderContract(provider) {
  const parsed = targetProviderContractSchema.safeParse(provider);
  if (!parsed.success) {
    throw new TargetProviderError(`invalid target provider: ${formatIssues(parsed.error)}`);
  }
  return parsed.data;
}

/**
 * Validate a client-supplied target id against the opaque-identifier
 * pattern. Call this before handing the id to any provider hook -- it is
 * the boundary that stops a path-shaped string from ever reaching
 * adapter-specific resolution logic.
 */
export function parseTargetId(targetId) {
  const parsed = targetIdSchema.safeParse(targetId);
  if (!parsed.success) {
    throw new InvalidTargetIdError(targetId);
  }
  return parsed.data;
}

export function validatePublicTarget(target) {
  const parsed = publicTargetSchema.safeParse(target);
  if (!parsed.success) {
    throw new TargetProviderError(`invalid public target descriptor: ${formatIssues(parsed.error)}`);
  }
  return parsed.data;
}

export function validateResolvedTarget(target) {
  const parsed = resolvedTargetSchema.safeParse(target);
  if (!parsed.success) {
    throw new TargetProviderError(`invalid resolved target descriptor: ${formatIssues(parsed.error)}`);
  }
  return parsed.data;
}
