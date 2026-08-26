import path from "node:path";
import { readFile } from "node:fs/promises";
import { z } from "zod";
import { targetIdSchema } from "@majiwari/registry";

export const RESIDENT_CONFIG_VERSION = 1;
export const DEFAULT_RESIDENT_PORT = 8787;
export const DEFAULT_RESIDENT_CONFIG_FILE = "majiwari.runtime.json";

const repoPathSchema = z
  .string()
  .min(1, "repo is required")
  .refine((value) => path.isAbsolute(value), "repo must be an absolute path")
  .refine((value) => !value.includes("\0") && !/[\r\n]/u.test(value), "repo contains unsafe characters");

const enabledSingleRepoAdapterSchema = z
  .object({
    enabled: z.literal(true),
    repo: repoPathSchema
  })
  .strict();

// A second, generic shape for "enabled": a static list of named targets
// (id + absolute repo path) instead of one fixed repo. Config stays
// adapter-agnostic here -- it is only "repo, or a list of id/repo pairs";
// what an adapter *does* with `targets` (or whether it supports the field
// at all) is decided at the trusted composition edge (`catalog.js`), not
// here. This is the seam #29's fixture/local target-provider smoke uses;
// it carries no Mottainai-specific (#30/#45) discovery of its own.
const enabledMultiTargetAdapterSchema = z
  .object({
    enabled: z.literal(true),
    targets: z
      .array(
        z
          .object({
            id: targetIdSchema,
            repo: repoPathSchema
          })
          .strict()
      )
      .min(1, "targets must contain at least one entry")
      .refine((targets) => new Set(targets.map((target) => target.id)).size === targets.length, "target ids must be unique")
  })
  .strict();

const disabledAdapterSchema = z
  .object({
    enabled: z.literal(false)
  })
  .strict();

const adapterConfigSchema = z.union([enabledSingleRepoAdapterSchema, enabledMultiTargetAdapterSchema, disabledAdapterSchema]);

const adaptersSchema = z
  .object({
    "open-code-review": adapterConfigSchema.optional(),
    inari: adapterConfigSchema.optional()
  })
  .strict();

const residentConfigSchema = z
  .object({
    version: z.literal(RESIDENT_CONFIG_VERSION, {
      message: `version must be ${RESIDENT_CONFIG_VERSION}`
    }),
    port: z.number().int("port must be an integer").min(1, "port must be between 1 and 65535").max(65535, "port must be between 1 and 65535").optional(),
    adapters: adaptersSchema.optional()
  })
  .strict();

export class ResidentConfigError extends Error {
  constructor(message, options) {
    super(message, options);
    this.name = "ResidentConfigError";
  }
}

function formatIssues(error) {
  return error.issues
    .map((issue) => {
      const field = issue.path.length ? issue.path.join(".") : "(config)";
      return `${field}: ${issue.message}`;
    })
    .join("; ");
}

/**
 * Validate and normalize the closed resident configuration contract.
 * Validation is deliberately independent of filesystem/process/network
 * access so callers can reject a bad config before creating runtime state.
 */
export function parseResidentConfig(value) {
  const parsed = residentConfigSchema.safeParse(value);
  if (!parsed.success) {
    throw new ResidentConfigError(`invalid resident config: ${formatIssues(parsed.error)}`);
  }

  return {
    version: RESIDENT_CONFIG_VERSION,
    port: parsed.data.port ?? DEFAULT_RESIDENT_PORT,
    adapters: {
      ...(parsed.data.adapters ?? {})
    }
  };
}

/** Load JSON and then apply the same closed schema as in-memory callers. */
export async function loadResidentConfig(filePath = DEFAULT_RESIDENT_CONFIG_FILE) {
  let source;
  try {
    source = await readFile(filePath, "utf8");
  } catch {
    throw new ResidentConfigError("cannot read resident config file");
  }

  let value;
  try {
    value = JSON.parse(source);
  } catch {
    throw new ResidentConfigError("resident config file must contain valid JSON");
  }
  return parseResidentConfig(value);
}

export function enabledResidentAdapters(config) {
  const normalized = parseResidentConfig(config);
  return ["open-code-review", "inari"]
    .filter((id) => normalized.adapters[id]?.enabled === true)
    .map((id) => {
      const adapter = normalized.adapters[id];
      return "targets" in adapter ? { id, targets: adapter.targets } : { id, repo: adapter.repo };
    });
}
